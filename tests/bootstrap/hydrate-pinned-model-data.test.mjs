import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { hydratePinnedModelCatalog } from "../../vendor/pi/scripts/update-model-catalog-pin.mjs";

const model = {
  type: "chat",
  id: "model-a",
  name: "Model A",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};
const catalog = Buffer.from(
  `${JSON.stringify({ "test-provider": [model] })}\n`,
);
const revision = `sha256-${createHash("sha256").update(catalog).digest("hex")}`;
const pin = `${JSON.stringify({ revision }, null, 2)}\n`;
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-pinned-catalog-"));
  mkdirSync(join(root, "packages/ai/src/providers"), { recursive: true });
  mkdirSync(join(root, "nix"));
  writeFileSync(
    join(root, "packages/ai/src/models.generated.ts"),
    'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
  );
  writeFileSync(
    join(root, "packages/ai/src/providers/test-provider.models.ts"),
    "",
  );
  writeFileSync(join(root, "nix/model-catalog.json"), pin);
});

afterEach(() => {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
});

// #77
test("hydrates only the hash-verified existing model catalog pin", async () => {
  const requests = [];
  mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return new Response(catalog);
  });

  assert.equal(await hydratePinnedModelCatalog(root), revision);
  assert.deepEqual(requests, [
    `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`,
  ]);
  assert.equal(readFileSync(join(root, "nix/model-catalog.json"), "utf8"), pin);
  assert.equal(
    JSON.parse(
      readFileSync(
        join(root, "packages/ai/src/providers/data/test-provider.json"),
        "utf8",
      ),
    )["openai-completions"]["chat:model-a"].id,
    model.id,
  );
});

// #77
test("rejects unavailable or modified pinned catalog bytes without changing the pin", async (t) => {
  await t.test("unavailable revision", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 503 }),
    );
    await assert.rejects(
      hydratePinnedModelCatalog(root),
      /unavailable: HTTP 503/,
    );
    assert.equal(
      readFileSync(join(root, "nix/model-catalog.json"), "utf8"),
      pin,
    );
  });

  await t.test("hash mismatch", async () => {
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => new Response("tampered"));
    await assert.rejects(
      hydratePinnedModelCatalog(root),
      /does not match its content/,
    );
    assert.equal(
      readFileSync(join(root, "nix/model-catalog.json"), "utf8"),
      pin,
    );
  });
});
