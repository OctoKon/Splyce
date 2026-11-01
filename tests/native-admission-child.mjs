import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bindSplyceToolAdmission,
  runToolCall,
} from "@earendil-works/pi-agent-core";
import { NativePolicy } from "../packages/splyce-pi/dist/policy.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import {
  IDENTITY,
  MemoryWorkspaceIdentity,
} from "./fixtures/native-grants.mjs";

const [dir, encodedPermit, mode] = process.argv.slice(2);
const permit = JSON.parse(encodedPermit);
const store = Store.open(join(dir, "store.db"));
const refs = new Set([
  "s1",
  "b1",
  "w-demo",
  "snapshot1",
  "e1",
  "grant1",
  "p1",
  "binding1",
  "cap1",
  "args1",
]);
const caller = {
  sessionId: "s1",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: (id, scope) =>
    scope === "w-demo" &&
    (refs.has(id) ||
      store
        .list(scope)
        .records.some(
          ({ record }) =>
            record.recordId === id ||
            record.runId === id ||
            record.actionId === id,
        )),
};
const identity = new MemoryWorkspaceIdentity();
identity.set(permit.ownership.workspaceId, IDENTITY);
const policy = new NativePolicy(
  store,
  caller,
  () => ({ ...caller, grantIds: [permit.grantId], planMode: false }),
  identity,
);
policy.authorize(permit);
const tool = {
  name: "fixture_write",
  label: "Fixture write",
  description: "Owned crash fixture",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: async () => {
    await writeFile(join(dir, "intent-ready"), "durable");
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  },
};
bindSplyceToolAdmission(tool, policy);
await runToolCall(
  {
    type: "toolCall",
    id: permit.toolCallId,
    name: tool.name,
    arguments: { text: "changed" },
  },
  {
    tools: [tool],
    context: { messages: [], tools: [tool] },
    assistantMessage: { role: "assistant", content: [], timestamp: 0 },
    beforeToolCall:
      mode === "proposal"
        ? async () => {
            await writeFile(join(dir, "proposal-ready"), "durable");
            process.send?.("proposal-ready");
            await new Promise(() => {
              setInterval(() => {}, 1000);
            });
          }
        : undefined,
  },
);
