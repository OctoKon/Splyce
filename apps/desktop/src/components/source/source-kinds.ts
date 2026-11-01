export const SOURCE_KINDS = [
  "user",
  "engine",
  "tool",
  "plugin",
  "provider",
  "memory",
  "external",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_VIEWS: Readonly<
  Record<SourceKind, { label: string; glyph: string }>
> = Object.freeze({
  user: { label: "User", glyph: "U" },
  engine: { label: "Engine", glyph: "E" },
  tool: { label: "Tool", glyph: "T" },
  plugin: { label: "Plugin", glyph: "P" },
  provider: { label: "Provider", glyph: "V" },
  memory: { label: "Memory", glyph: "M" },
  external: { label: "External page", glyph: "W" },
});

/** Trust follows the kind; a caller flag may only add untrusted, never remove it. */
export function isUntrusted(kind: SourceKind, untrusted?: boolean): boolean {
  return kind === "external" || untrusted === true;
}
