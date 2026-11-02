import {
	Agent,
	type AgentMessage,
	type AgentOptions,
	assertSameSplyceOwner,
	assertSplycePersistence,
	assertSplyceReady,
	inheritSplyceOwner,
	isSplyceLoopRequest,
	setDefaultStreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, type AgentSessionConfig } from "./agent-session.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { getClientIdentity } from "./client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import { getToolListError, type SettingsManager } from "./settings-manager.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, pi uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for codemode and tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	assertSplyceReady(options);
	assertSameSplyceOwner(options, options, "sdk-options");
	if (
		!options.cwd ||
		!options.agentDir ||
		!options.model ||
		!options.modelRuntime ||
		!options.sessionManager ||
		!options.settingsManager ||
		!options.resourceLoader ||
		!Array.isArray(options.tools)
	) {
		throw Object.assign(new Error("SPLYCE_UNAVAILABLE"), { code: "SPLYCE_UNAVAILABLE" });
	}
	const { model, modelRuntime, settingsManager, sessionManager, resourceLoader } = options;
	assertSameSplyceOwner(options, model, "model");
	assertSameSplyceOwner(options, modelRuntime, "model-runtime");
	assertSameSplyceOwner(options, settingsManager, "settings-manager");
	assertSameSplyceOwner(options, sessionManager, "session-manager");
	assertSplycePersistence(sessionManager);
	assertSameSplyceOwner(options, resourceLoader, "resource-loader");
	for (const scoped of options.scopedModels ?? []) assertSameSplyceOwner(options, scoped.model, "model");
	const cwd = resolvePath(options.cwd);

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	if (options.tools.some((name) => name.startsWith("+") || name.startsWith("-"))) {
		throw new Error("Owned sessions require an explicit tool allowlist");
	}
	const allowedToolNames = options.tools;
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = options.tools.filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		const transformHeaders: ModelsSimpleStreamOptions["transformHeaders"] = headerRunner?.hasHandlers(
			"before_provider_headers",
		)
			? (headers) => headerRunner.emitBeforeProviderHeaders(headers)
			: undefined;
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			// Replaces the agent loop's default identity; read per request so telemetry changes apply at once.
			identity: getClientIdentity(settingsManager),
			...(transformHeaders ? { transformHeaders } : {}),
		};
	};
	// Warm only requests for the selected model. Requests a virtual selection routed, or that an
	// extension redirected, may not be repeated by the next request, so warming them could be wasted.
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};
	const nativeRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		const unsupported = (): never => {
			throw Object.assign(new Error("PROVIDER_OPTIONS_UNSUPPORTED"), { code: "PROVIDER_OPTIONS_UNSUPPORTED" });
		};
		if (options === null || typeof options !== "object") unsupported();
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) unsupported();
		const runner = extensionRunnerRef.current;
		const providerHooks = [
			"before_provider_headers",
			"before_provider_request",
			"after_provider_response",
			"provider_stream_event",
		] as const;
		if (providerHooks.some((event) => runner?.hasHandlers(event))) unsupported();
		// Accessor defaults belong to the donor transport. Explicit settings remain semantics,
		// even when their value happens to equal one of those defaults.
		const settings = settingsManager.getSettings();
		if (
			settings.transport !== undefined ||
			settings.httpIdleTimeoutMs !== undefined ||
			settings.websocketConnectTimeoutMs !== undefined ||
			settings.thinkingBudgets !== undefined ||
			Object.values(settings.retry?.provider ?? {}).some((value) => value !== undefined)
		)
			unsupported();
		const projected: Record<string, unknown> = Object.fromEntries(
			Reflect.ownKeys(options).map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(options, key);
				if (typeof key !== "string" || !descriptor || !("value" in descriptor)) return unsupported();
				return [key, descriptor.value];
			}),
		);
		if (isSplyceLoopRequest(agent, options)) {
			// These exact fields have already been consumed by the proven SDK Agent loop.
			// They are not provider callbacks or provider request options.
			for (const key of [
				"model",
				"convertToLlm",
				"transformContext",
				"getApiKey",
				"beforeToolCall",
				"afterToolCall",
				"finishTurn",
				"prepareRequest",
				"prepareNextTurn",
				"getSteeringMessages",
				"getFollowUpMessages",
				"toolExecution",
			])
				delete projected[key];
			if (agent.onPayload === transformProviderPayload) delete projected.onPayload;
			if (agent.onResponse === handleProviderResponse) delete projected.onResponse;
			if (agent.onProviderStreamEvent === handleProviderStreamEvent) delete projected.onProviderStreamEvent;
			if (agent.sessionId === agentOptions.sessionId && projected.sessionId === agentOptions.sessionId)
				delete projected.sessionId;
			if (agent.transport === agentOptions.transport && projected.transport === agentOptions.transport)
				delete projected.transport;
			if (
				agent.maxRetryDelayMs === agentOptions.maxRetryDelayMs &&
				projected.maxRetryDelayMs === agentOptions.maxRetryDelayMs
			)
				delete projected.maxRetryDelayMs;
			if (agent.identity === undefined) delete projected.identity;
		}
		for (const key of Object.keys(projected)) {
			if (projected[key] === undefined) delete projected[key];
			else if (key !== "signal") unsupported();
		}
		return projected as ModelsSimpleStreamOptions;
	};

	const agentOptions: AgentOptions = {
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			if (modelRuntime.getRegisteredNativeProvider(model.provider))
				return modelRuntime.streamSimple(model, context, nativeRequestOptions(options));
			const requestOptions = buildRequestOptions(options);
			// Compaction and summaries use their own routing ids; only session requests
			// replace the cache entry, so warming restarts from them. Keep warming while
			// the current transcript still extends the request's prefix. Agent state may
			// shallow-copy the messages array or refresh the model object without changing
			// the provider request, so top-level object identity is not a valid cache key.
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	};
	inheritSplyceOwner(options, agentOptions, "agent-options");

	// Commit setup metadata before exposing the session to callers or extensions.
	await sessionManager.withPersistence((manager) => {
		if (hasExistingSession) {
			if (!hasThinkingEntry) manager.appendThinkingLevelChange(thinkingLevel);
		} else {
			if (model) manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange(thinkingLevel);
		}
	});
	if (agentOptions.initialState) agentOptions.initialState.messages = sessionManager.buildSessionContext().messages;
	const agent = new Agent(agentOptions);

	const sessionOptions: AgentSessionConfig = {
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: false,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	};
	inheritSplyceOwner(options, sessionOptions, "session-options");
	const session = new AgentSession(sessionOptions);
	try {
		await session.initialize();
	} catch (error) {
		session.dispose();
		throw error;
	}

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
	};
}
