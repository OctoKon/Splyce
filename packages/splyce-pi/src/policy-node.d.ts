// Same narrow built-in typing convention as the store; no additional dependency.
declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomUUID(): string;
}
