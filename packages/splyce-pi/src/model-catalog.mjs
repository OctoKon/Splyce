import { createHash } from "node:crypto";
import { canonicalEndpointUrl } from "../dist/contracts.js";
import openai from "../../../vendor/pi/packages/ai/src/providers/data/openai.json" with { type: "json" };

const catalog = structuredClone(openai);
const digest = createHash("sha256")
  .update(JSON.stringify(catalog))
  .digest("hex");
const catalogVersion = `openai-v1-${digest}`;
const pinnedDigest =
  "63c2d976a95b6b6dc0171002549e9756f6ab29e9e0538c63baf04b984e148b6e";
const allowedApis = new Set(["openai-completions", "openai-responses"]);

function canonicalBase(value) {
  if (typeof value !== "string") return null;
  try {
    return canonicalEndpointUrl(value, "hosted");
  } catch {
    return null;
  }
}

export function lookupPinnedModel({ apiFamily, endpoint, modelId } = {}) {
  if (
    digest !== pinnedDigest ||
    !allowedApis.has(apiFamily) ||
    typeof modelId !== "string" ||
    !modelId
  )
    return null;
  const model = catalog[apiFamily]?.[`chat:${modelId}`];
  if (
    !model ||
    model.type !== "chat" ||
    model.api !== apiFamily ||
    model.id !== modelId ||
    model.provider !== "openai" ||
    typeof model.name !== "string" ||
    !model.name.trim() ||
    typeof model.reasoning !== "boolean" ||
    !Array.isArray(model.input) ||
    !model.input.length ||
    !model.input.includes("text") ||
    model.input.some((modality) => !["text", "image"].includes(modality)) ||
    new Set(model.input).size !== model.input.length ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow <= 0 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0 ||
    model.maxTokens > model.contextWindow ||
    !canonicalBase(endpoint) ||
    canonicalBase(endpoint) !== canonicalBase(model.baseUrl)
  )
    return null;
  const costKnown = ["input", "output", "cacheRead", "cacheWrite"].every(
    (key) =>
      typeof model.cost?.[key] === "number" &&
      Number.isFinite(model.cost[key]) &&
      model.cost[key] > 0,
  );
  return {
    descriptor: {
      source: "catalog",
      catalogVersion,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: [...model.input],
      costKnown,
    },
    metadata: structuredClone(model),
  };
}
