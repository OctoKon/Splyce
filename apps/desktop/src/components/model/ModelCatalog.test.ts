import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ModelCatalog from "./ModelCatalog.svelte";
let component: object;
afterEach(() => {
  if (component) void unmount(component);
  document.body.innerHTML = "";
});
it("filters live catalog metadata and requests the chosen model", () => {
  const onUse = vi.fn(async () => {});
  const model = {
    modelId: "model-a",
    title: "Alpha",
    contextWindow: 64000,
    tools: true,
    paidOnly: true,
  };
  component = mount(ModelCatalog, {
    target: document.body,
    props: {
      profiles: [
        {
          profileId: "p",
          profileRevision: "1",
          configRevision: "1",
          credential: "configured",
          providerConnectionId: "c",
        },
      ],
      catalogProfileId: "p",
      catalog: { models: [model, { modelId: "other" }], truncated: false },
      catalogStatus: "Models loaded.",
      catalogPending: false,
      switchPending: false,
      onLoad: vi.fn(),
      onUse,
    },
  });
  flushSync();
  const search = document.querySelector<HTMLInputElement>("#catalog-search")!;
  search.value = "alpha";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(document.body.textContent).toContain("64,000");
  expect(document.body.textContent).toContain("Paid only");
  expect(document.body.textContent).not.toContain("other");
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent === "Use this model")!
    .click();
  expect(onUse).toHaveBeenCalledWith(model);
});
