import { engine } from "./engine";

export async function readUsage(workspaceId: string, requestId: string) {
  return engine.readPage("usage.read", requestId, { workspaceId });
}
