// TD-70 child tool composition: Pi's own built-in tools, rooted at the child
// root (parent workspace for read children, the worktree for write children).
// Pi grep/find are left out: they may fetch rg/fd on first use (no implicit
// installs); search goes through code_* instead. No shell tool: without an OS
// sandbox a shell could write outside the child root. Unwired until the native
// host has an engine generation; E1_readonly_subagents exercises it.
import {
  createEditTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

/**
 * Adapts a `{ name, description, parameters, execute(args) }` tool (code index,
 * memory) to a Pi AgentTool; `details` keeps the structured result for citations.
 */
export function agentToolFrom(tool) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_toolCallId, params) {
      const value = await tool.execute(params);
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
      };
    },
  };
}

/**
 * Capability → tool factory map for SubagentHost.tools. `codeTools` /
 * `memoryTools` are factories returning the plain tools for one child.
 */
export function childToolFactories({ codeTools, memoryTools } = {}) {
  return {
    "fs.read": (root) => [createReadTool(root), createLsTool(root)],
    "fs.write": (root) => [createWriteTool(root), createEditTool(root)],
    ...(codeTools
      ? { "code.index": () => codeTools().map(agentToolFrom) }
      : {}),
    ...(memoryTools
      ? { "memory.query": () => memoryTools().map(agentToolFrom) }
      : {}),
  };
}
