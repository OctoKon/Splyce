export type LineKind = "add" | "del" | "ctx" | "note";

export interface DiffLine {
  readonly kind: LineKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
}

export interface Hunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly binary: boolean;
  readonly hunks: readonly Hunk[];
}

export interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

interface MutableFile {
  path: string;
  binary: boolean;
  hunks: Hunk[];
}

/** Parse git-style unified diff text. Hunk bodies are consumed by header counts, so content lines that look like headers stay content. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const src = text.split("\n");
  if (src.at(-1) === "") src.pop();
  const files: MutableFile[] = [];
  let cur: MutableFile | null = null;
  const open = (path: string): MutableFile => {
    const f: MutableFile = { path, binary: false, hunks: [] };
    files.push(f);
    return f;
  };
  for (let i = 0; i < src.length; i++) {
    const l = src[i]!;
    if (l.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      cur = open(m ? m[2]! : l.slice(11));
    } else if (l.startsWith("--- ") && (src[i + 1] ?? "").startsWith("+++ ")) {
      const np = src[i + 1]!.slice(4).trim();
      const op = l.slice(4).trim();
      const path = stripPrefix(np === "/dev/null" ? op : np);
      if (!cur || cur.hunks.length > 0) cur = open(path);
      else cur.path = path;
      i++;
    } else if (
      cur &&
      (l.startsWith("Binary files ") || l === "GIT binary patch")
    ) {
      cur.binary = true;
    } else {
      const m = HUNK.exec(l);
      if (!m || !cur) continue;
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      let o = Number(m[1]);
      let n = Number(m[3]);
      const lines: DiffLine[] = [];
      while (
        i + 1 < src.length &&
        (oldLeft > 0 || newLeft > 0 || src[i + 1]!.startsWith("\\"))
      ) {
        const b = src[++i]!;
        const c = b[0];
        if (c === "\\") {
          lines.push({
            kind: "note",
            oldNo: null,
            newNo: null,
            text: b.slice(2),
          });
        } else if (c === "+") {
          lines.push({
            kind: "add",
            oldNo: null,
            newNo: n++,
            text: b.slice(1),
          });
          newLeft--;
        } else if (c === "-") {
          lines.push({
            kind: "del",
            oldNo: o++,
            newNo: null,
            text: b.slice(1),
          });
          oldLeft--;
        } else {
          lines.push({ kind: "ctx", oldNo: o++, newNo: n++, text: b.slice(1) });
          oldLeft--;
          newLeft--;
        }
      }
      cur.hunks.push({ header: l, lines });
    }
  }
  return files;
}

/** Pair consecutive deletions with additions for side-by-side display. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (l.kind === "del" || l.kind === "add") {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (lines[i]?.kind === "del") dels.push(lines[i++]!);
      while (lines[i]?.kind === "add") adds.push(lines[i++]!);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    } else {
      rows.push({ left: l, right: l });
      i++;
    }
  }
  return rows;
}

export const KIND_LABEL: Record<LineKind, string> = {
  add: "Added",
  del: "Removed",
  ctx: "Unchanged",
  note: "Note",
};
export const KIND_GLYPH: Record<LineKind, string> = {
  add: "+",
  del: "-",
  ctx: " ",
  note: "\\",
};
