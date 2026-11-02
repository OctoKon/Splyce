import type { Agent } from "./agent.ts";
import type { AgentTool, StreamFn } from "./types.ts";

export type SplyceRole =
	| "sdk-options"
	| "agent-options"
	| "agent"
	| "loop-config"
	| "session-options"
	| "session"
	| "runner"
	| "tool"
	| "model-runtime-options"
	| "model-runtime"
	| "resource-loader-options"
	| "resource-loader"
	| "session-manager"
	| "settings-manager"
	| "model";

interface Owner {
	checkCurrent: () => void;
	disposed: boolean;
}
interface Binding {
	owner: Owner;
	role: SplyceRole;
}
const bindings = new WeakMap<object, Binding>();
export type SplycePersistenceSanitizer = (serialized: string, signal?: AbortSignal) => Promise<string>;
const persistence = new WeakMap<object, { owner: Owner; sanitize: SplycePersistenceSanitizer }>();

function persistenceUnavailable(
	code: "PERSIST_REDACTION_UNAVAILABLE" | "PERSIST_ENTRY_TOO_LARGE" = "PERSIST_REDACTION_UNAVAILABLE",
): never {
	throw Object.assign(new Error(code), { code });
}

/** Persistence refusal must not become an ordinary model/tool fallback response. */
export function rethrowSplycePersistenceError(error: unknown): void {
	const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
	const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
	if (code === "PERSIST_REDACTION_UNAVAILABLE" || code === "PERSIST_ENTRY_TOO_LARGE") persistenceUnavailable(code);
}

/** A disposed identity stays owned: it must never fall back to donor synchronous writes. */
export function isSplyceOwned(subject: object): boolean {
	return bindings.has(subject);
}

export function assertSplycePersistence(subject: object): void {
	try {
		const binding = current(subject);
		if (binding.role !== "session-manager" || persistence.get(subject)?.owner !== binding.owner)
			persistenceUnavailable();
	} catch {
		persistenceUnavailable();
	}
}

/** The native closure owns the existing redaction lane; Pi never obtains matcher secrets. */
export async function sanitizeSplycePersistence(
	subject: object,
	serialized: string,
	signal?: AbortSignal,
): Promise<string> {
	try {
		assertSplycePersistence(subject);
		signal?.throwIfAborted();
		if (typeof serialized !== "string") persistenceUnavailable();
		const sanitized = await persistence.get(subject)!.sanitize(serialized, signal);
		signal?.throwIfAborted();
		assertSplycePersistence(subject);
		if (typeof sanitized !== "string") persistenceUnavailable();
		return sanitized;
	} catch (error) {
		rethrowSplycePersistenceError(error);
		return persistenceUnavailable();
	}
}
const callbackKeys = [
	"convertToLlm",
	"transformContext",
	"getApiKey",
	"beforeToolCall",
	"afterToolCall",
	"prepareRequest",
	"prepareNextTurn",
	"prepareNextTurnWithContext",
	"finishTurn",
	"onPayload",
	"onResponse",
	"onProviderStreamEvent",
] as const;
type Callbacks = Pick<Agent, (typeof callbackKeys)[number]>;
const callbacks = new WeakMap<object, Callbacks>();
const sealedAgents = new WeakSet<object>();
function captureCallbacks(agent: Agent): void {
	callbacks.set(agent, Object.fromEntries(callbackKeys.map((key) => [key, agent[key]])) as Callbacks);
}

/** Session wrappers are installed synchronously before the initialized Agent is exposed. */
export function sealSplyceAgentCallbacks(session: object, agent: Agent): void {
	assertSameSplyceOwner(session, session, "session");
	assertSameSplyceOwner(session, agent, "agent");
	if (sealedAgents.has(agent)) unavailable();
	captureCallbacks(agent);
	sealedAgents.add(agent);
}

export function getSplyceAgentCallbacks(agent: Agent): Callbacks {
	assertSameSplyceOwner(agent, agent, "agent");
	const snapshot = callbacks.get(agent);
	if (!snapshot || callbackKeys.some((key) => snapshot[key] !== agent[key])) unavailable();
	return snapshot;
}

const loopCallbackKeys = [
	...callbackKeys.filter((key) => key !== "prepareNextTurnWithContext"),
	"getSteeringMessages",
	"getFollowUpMessages",
];
const loopCallbacks = new WeakMap<object, Record<string, unknown>>();
const loopAgents = new WeakMap<object, Agent>();
const loopRequests = new WeakMap<object, Map<PropertyKey, unknown>>();
const streams = new WeakMap<object, StreamFn>();
const toolImplementations = new WeakMap<object, AgentTool["execute"]>();
const derivations: Partial<Record<SplyceRole, readonly SplyceRole[]>> = {
	"sdk-options": ["agent-options", "session-options"],
	"agent-options": ["agent"],
	"session-options": ["session"],
	session: ["runner", "tool"],
	"model-runtime-options": ["model-runtime"],
	"resource-loader-options": ["resource-loader"],
};

function unavailable(): never {
	throw Object.assign(new Error("SPLYCE_UNAVAILABLE"), { code: "SPLYCE_UNAVAILABLE" as const });
}

function current(subject?: object): Binding {
	const binding = subject && bindings.get(subject);
	if (!binding || binding.owner.disposed) return unavailable();
	binding.owner.checkCurrent();
	if (binding.owner.disposed) return unavailable();
	if (binding.role === "loop-config") {
		const snapshot = loopCallbacks.get(subject!);
		if (!snapshot || loopCallbackKeys.some((key) => snapshot[key] !== (subject as Record<string, unknown>)[key]))
			unavailable();
	}
	return binding;
}

function bind(owner: Owner, subject: object, role: SplyceRole): void {
	if (owner.disposed) unavailable();
	owner.checkCurrent();
	const previous = bindings.get(subject);
	if (owner.disposed || (previous && (previous.owner !== owner || previous.role !== role))) unavailable();
	bindings.set(subject, { owner, role });
	if (role === "agent" && !streams.has(subject)) {
		const stream = (subject as { streamFunction: StreamFn }).streamFunction;
		if (typeof stream !== "function") unavailable();
		streams.set(subject, stream);
		captureCallbacks(subject as Agent);
	}
	if (role === "tool" && !toolImplementations.has(subject)) {
		const tool = subject as AgentTool;
		if (typeof tool.execute !== "function") unavailable();
		toolImplementations.set(tool, tool.execute);
		tool.execute = () => unavailable();
	}
}

/** Private native composition entrypoint; deliberately absent from the package index. */
export function createSplyceOwner(checkCurrent: () => void): {
	bind: (subject: object, role: SplyceRole) => void;
	bindPersistence: (subject: object, sanitizer: SplycePersistenceSanitizer) => void;
	dispose: () => void;
} {
	const owner: Owner = { checkCurrent, disposed: false };
	return {
		bind: (subject, role) => bind(owner, subject, role),
		bindPersistence: (subject, sanitize) => {
			try {
				if (typeof sanitize !== "function" || persistence.has(subject)) persistenceUnavailable();
				bind(owner, subject, "session-manager");
				persistence.set(subject, { owner, sanitize });
				assertSplycePersistence(subject);
			} catch {
				persistenceUnavailable();
			}
		},
		dispose: () => {
			owner.disposed = true;
		},
	};
}

/** No object means no authority; standalone/default SDK callers remain unavailable. */
export const assertSplyceReady = (subject?: object): void => {
	current(subject);
};

/** Revocation needs no current-state check, so stale owners can always be cleaned up. */
export function disposeSplyceOwner(subject: object): void {
	const binding = bindings.get(subject);
	if (binding) binding.owner.disposed = true;
}

/** Inert constructors can stay unowned; an owned identity may never change its owner or role. */
export function inheritSplyceOwner(parent: object, child: object, role: SplyceRole): boolean {
	if (!bindings.has(parent)) return false;
	const binding = current(parent);
	if (!derivations[binding.role]?.includes(role)) unavailable();
	bind(binding.owner, child, role);
	return true;
}

/** Only native Agent construction and actual loop snapshots derive runnable configurations. */
export function inheritSplyceLoopConfig(parent: object, child: object): void {
	const binding = current(parent);
	const stream = streams.get(parent);
	if ((binding.role !== "agent" && binding.role !== "loop-config") || !stream) unavailable();
	bind(binding.owner, child, "loop-config");
	streams.set(child, stream);
	const agent = binding.role === "agent" ? (parent as Agent) : loopAgents.get(parent);
	if (!agent) unavailable();
	loopAgents.set(child, agent);
	loopCallbacks.set(
		child,
		Object.fromEntries(loopCallbackKeys.map((key) => [key, (child as Record<string, unknown>)[key]])),
	);
}

/** Only the actual loop can preserve the identity of its final provider request. */
export function inheritSplyceLoopRequest(parent: object, child: object): void {
	inheritSplyceLoopConfig(parent, child);
	loopRequests.set(child, new Map(Reflect.ownKeys(child).map((key) => [key, Reflect.get(child, key)])));
}

/** Comparison only: callers cannot mint a request or attach authority to a copy. */
export function isSplyceLoopRequest(agent: Agent, request: object): boolean {
	if (!loopRequests.has(request) || loopAgents.get(request) !== agent) return false;
	const snapshot = loopRequests.get(request)!;
	const keys = Reflect.ownKeys(request);
	const unchanged =
		keys.length === snapshot.size &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(request, key);
			return descriptor && "value" in descriptor && snapshot.has(key) && descriptor.value === snapshot.get(key);
		});
	if (!unchanged) return false;
	assertSameSplyceOwner(agent, request, "loop-config");
	getSplyceAgentCallbacks(agent);
	return true;
}

export function assertSplyceLoopStream(config: object, stream: StreamFn): void {
	assertSameSplyceOwner(config, config, "loop-config");
	if (streams.get(config) !== stream) unavailable();
}

export function assertSplyceToolCurrent(tool: AgentTool, signal?: AbortSignal): void {
	if (bindings.has(tool)) assertSameSplyceOwner(tool, tool, "tool");
	signal?.throwIfAborted();
}

/** Called only inside the already-admitted execution callback, never exported by the SDK. */
export function getSplyceToolImplementation(tool: AgentTool): AgentTool["execute"] {
	const execute = toolImplementations.get(tool);
	if (execute) assertSameSplyceOwner(tool, tool, "tool");
	return execute ?? tool.execute;
}

export function assertSameSplyceOwner(parent: object, child: object, expectedRole?: SplyceRole): void {
	const a = current(parent);
	const b = current(child);
	if (a.owner !== b.owner || (expectedRole && b.role !== expectedRole)) unavailable();
}
