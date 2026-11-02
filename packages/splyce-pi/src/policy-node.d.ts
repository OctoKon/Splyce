// Same narrow built-in typing convention as the store; no additional dependency.
declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
}
// TD-70 child path confinement (node:path comes from workspace-tools-node.d.ts).
declare module "node:fs" {
  export function realpathSync(path: string): string;
  export namespace realpathSync {
    export function native(path: string): string;
  }
}
