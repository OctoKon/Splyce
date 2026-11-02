import {
  assertGone,
  closeApplication,
  connected,
  verifyOwned,
} from "./desktop.mjs";

describe("packaged bootstrap native shutdown", () => {
  it("closing the real window cleans its still-running bundled engine", async () => {
    const { application, engine } = await connected();
    verifyOwned(application, engine);
    await closeApplication(application);
    await assertGone(application, engine);
  });
});
