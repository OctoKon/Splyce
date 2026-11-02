import type { SplyceCredentials } from "../splyce-credentials.ts";
import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** Only adapters bound to native credentials may bypass ordinary provider auth. */
export const CREDENTIAL_APIS: ReadonlySet<string> = new Set([
	"anthropic-messages",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
	"pi-messages",
]);

export function assertCredentialsSupported(
	api: string,
	options: { credentials?: SplyceCredentials | undefined } | undefined,
): void {
	if (options?.credentials && !CREDENTIAL_APIS.has(api)) {
		throw new Error(`credentials are not supported for api ${api} yet`);
	}
}

/** The type of a model. Models without `type` are chat models. */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** Rejects classifier images for models whose catalog entry does not accept image input. */
export function assertClassifierInputSupported(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
): void {
	if (context.images?.length && !model.input.includes("image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
	}
}

export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
