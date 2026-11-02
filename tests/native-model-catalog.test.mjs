import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lookupPinnedModel } from "../packages/splyce-pi/src/model-catalog.mjs";

const tuple = {
  apiFamily: "openai-responses",
  endpoint: "https://api.openai.com/v1",
  modelId: "gpt-4o-mini",
};

test("pinned lookup returns the actual model with conservative cost provenance", () => {
  const found = lookupPinnedModel(tuple);
  assert.equal(found.metadata.id, tuple.modelId);
  assert.equal(found.metadata.name, "GPT-4o mini");
  assert.equal(found.descriptor.contextWindow, 128000);
  assert.equal(found.descriptor.maxOutputTokens, 16384);
  assert.deepEqual(found.descriptor.input, ["text", "image"]);
  assert.equal(found.metadata.cost.cacheWrite, 0);
  assert.equal(found.descriptor.costKnown, false);
  assert.match(found.descriptor.catalogVersion, /^openai-v1-[a-f0-9]{64}$/);
  assert.equal(
    found.descriptor.catalogVersion,
    lookupPinnedModel(tuple).descriptor.catalogVersion,
  );
  assert.deepEqual(
    lookupPinnedModel({ ...tuple, endpoint: "https://API.OPENAI.COM:443/v1/" }),
    found,
  );
});

test("requires an exact pinned API, model and base URL", () => {
  for (const override of [
    { apiFamily: "openai-completions" },
    { apiFamily: "openai-decisions" },
    { modelId: "GPT-4o-mini" },
    { modelId: "missing" },
    { endpoint: "https://api.openai.com/v1/other" },
    { endpoint: "https://api.openai.com" },
    { endpoint: "https://api.openai.com.evil.test/v1" },
    { endpoint: "http://localhost:8080/v1" },
    { endpoint: "https://api.openai.com/v1?key=x" },
    { endpoint: "https://user@api.openai.com/v1" },
    { endpoint: "https:api.openai.com/v1" },
    { endpoint: "https://api.openai.com/v1/../v1" },
    { endpoint: "https://api.openai.com/v1/%2e%2e/v1" },
  ])
    assert.equal(lookupPinnedModel({ ...tuple, ...override }), null);
});

test("returned metadata and descriptor cannot corrupt subsequent lookup", () => {
  const first = lookupPinnedModel(tuple);
  first.metadata.cost.input = 0;
  first.metadata.input.push("audio");
  first.descriptor.input.push("audio");
  const next = lookupPinnedModel(tuple);
  assert.equal(next.metadata.cost.input, 0.15);
  assert.deepEqual(next.metadata.input, ["text", "image"]);
  assert.deepEqual(next.descriptor.input, ["text", "image"]);
});

test("shared JSON cache mutations cannot change or impersonate the pinned snapshot", () => {
  const jsonUrl = new URL(
    "../vendor/pi/packages/ai/src/providers/data/openai.json",
    import.meta.url,
  ).href;
  const lookupUrl = new URL(
    "../packages/splyce-pi/src/model-catalog.mjs",
    import.meta.url,
  ).href;
  for (const mutateFirst of [false, true]) {
    const script = `
      import assert from 'node:assert/strict';
      const data = (await import(${JSON.stringify(jsonUrl)}, { with: { type: 'json' } })).default;
      const tuple = ${JSON.stringify(tuple)};
      if (${mutateFirst}) data['openai-responses']['chat:gpt-4o-mini'].contextWindow++;
      const { lookupPinnedModel } = await import(${JSON.stringify(lookupUrl)});
      const before = lookupPinnedModel(tuple);
      if (${mutateFirst}) assert.equal(before, null);
      else {
        data['openai-responses']['chat:gpt-4o-mini'].contextWindow++;
        assert.deepEqual(lookupPinnedModel(tuple), before);
        assert.equal(before.descriptor.contextWindow, 128000);
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
});
