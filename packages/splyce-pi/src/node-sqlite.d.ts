// Minimal ambient typings for the built-in `node:sqlite` module.
// Owned by TD-09; deliberately narrow — only the surface the store uses.
// Deliberately does NOT add `@types/node` (TD-11 owns the package manifest).

declare module "node:sqlite" {
  export interface StatementRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(...anonymousParameters: unknown[]): StatementRunResult;
    get(...anonymousParameters: unknown[]): unknown;
    all(...anonymousParameters: unknown[]): unknown[];
  }

  export interface DatabaseSyncOptions {
    open?: boolean | undefined;
    readOnly?: boolean | undefined;
    timeout?: number | undefined;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    open(path: string, options?: DatabaseSyncOptions): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    isTransaction: boolean;
  }

  export function backup(sourceDb: DatabaseSync, path: string): Promise<void>;
}

// Minimal ambient typings for `node:fs` — only the surface store.ts uses.
declare module "node:fs" {
  export function lstatSync(
    path: string,
    options: { throwIfNoEntry: false },
  ): { isSymbolicLink(): boolean } | undefined;
  export function statSync(path: string): { nlink: number };
  export function copyFileSync(src: string, dest: string): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean | undefined; force?: boolean | undefined },
  ): void;
  export function writeFileSync(
    path: string,
    data: string,
    options?: string | { encoding?: string | undefined },
  ): void;
  export function renameSync(oldPath: string, newPath: string): void;
}
