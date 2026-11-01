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
	dispose: () => void;
} {
	const owner: Owner = { checkCurrent, disposed: false };
	return {
		bind: (subject, role) => bind(owner, subject, role),
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
	loopCallbacks.set(
		child,
		Object.fromEntries(loopCallbackKeys.map((key) => [key, (child as Record<string, unknown>)[key]])),
	);
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
