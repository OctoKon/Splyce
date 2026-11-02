export interface ModelSummary {
  modelId: string;
  title?: string;
  contextWindow?: number;
  tools?: boolean;
  paidOnly?: boolean;
}
export interface ModelsListRequest {
  requestId: string;
  workspaceId: string;
  profileId: string;
}
export interface ModelsListResult {
  models: ModelSummary[];
  truncated: boolean;
}
export class ModelsListError extends Error {
  constructor(
    public readonly code:
      | "MODEL_CATALOG_INVALID"
      | "MODEL_CATALOG_UNAVAILABLE"
      | "MODEL_CATALOG_DENIED"
      | "MODEL_CATALOG_TIMEOUT",
  ) {
    super("Model catalog unavailable");
    this.name = "ModelsListError";
  }
}
const invalid = (): never => {
  throw new ModelsListError("MODEL_CATALOG_INVALID");
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.isWellFormed() &&
  value.length > 0 &&
  new TextEncoder().encode(value).length <= 128 &&
  !/[\s\p{Cc}\p{Cf}\\/]/u.test(value);
export function validateModelsListRequest(raw: unknown): ModelsListRequest {
  if (
    !object(raw) ||
    Object.keys(raw).length !== 3 ||
    !["requestId", "workspaceId", "profileId"].every((key) =>
      Object.hasOwn(raw, key),
    ) ||
    !id(raw.requestId) ||
    !id(raw.workspaceId) ||
    !id(raw.profileId)
  )
    invalid();
  return raw as ModelsListRequest;
}
export function validateModelsListResult(raw: unknown): ModelsListResult {
  if (
    !object(raw) ||
    Object.keys(raw).length !== 2 ||
    !Object.hasOwn(raw, "models") ||
    !Object.hasOwn(raw, "truncated") ||
    !Array.isArray(raw.models) ||
    raw.models.length > 500 ||
    typeof raw.truncated !== "boolean"
  )
    invalid();
  const seen = new Set<string>();
  for (const row of (raw as ModelsListResult).models) {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) =>
          !["modelId", "title", "contextWindow", "tools", "paidOnly"].includes(
            key,
          ),
      ) ||
      !Object.hasOwn(row, "modelId") ||
      typeof row.modelId !== "string" ||
      !row.modelId.isWellFormed() ||
      !row.modelId ||
      new TextEncoder().encode(row.modelId).length > 256 ||
      /[\s\p{Cc}\p{Cf}]/u.test(row.modelId) ||
      seen.has(row.modelId) ||
      ("title" in row &&
        (typeof row.title !== "string" ||
          !row.title.isWellFormed() ||
          row.title.length < 1 ||
          row.title.length > 256 ||
          /\p{Cc}/u.test(row.title))) ||
      ("contextWindow" in row &&
        (!Number.isInteger(row.contextWindow) ||
          (row.contextWindow as number) < 1 ||
          (row.contextWindow as number) > 2 ** 21)) ||
      ("tools" in row && typeof row.tools !== "boolean") ||
      ("paidOnly" in row && typeof row.paidOnly !== "boolean")
    )
      invalid();
    seen.add(row.modelId as string);
  }
  return raw as ModelsListResult;
}
