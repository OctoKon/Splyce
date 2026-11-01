// Minimal ambient typings for `node:child_process`; only the surface the TD-16
// credential helper runner uses. Deliberately does NOT add `@types/node`.

declare module "node:child_process" {
  export interface ExecFileError extends Error {
    code?: number | string | null;
    killed?: boolean;
  }
  export interface ExecFileOptions {
    shell: false;
    windowsHide: boolean;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileError | null, stdout: string) => void,
  ): unknown;
}
