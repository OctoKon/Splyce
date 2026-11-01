export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "link"; v: string; href: string }
  | { t: "unsafe-link"; v: string; href: string };

export type Block =
  | { t: "p"; inl: Inline[] }
  | { t: "h"; level: number; inl: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; items: Inline[][] };

/** Only these schemes may ever be opened; everything else is shown as inert text. */
export function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return (
      u.protocol === "https:" ||
      u.protocol === "http:" ||
      u.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

const TOKEN =
  /`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined)
      out.push({
        t: isSafeHref(m[3]!) ? "link" : "unsafe-link",
        v: m[2],
        href: m[3]!,
      });
    else if (m[4] !== undefined) out.push({ t: "strong", v: m[4] });
    else out.push({ t: "em", v: m[5]! });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/** Minimal Markdown subset to a typed block model. Raw HTML is never interpreted: it stays literal text. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inl: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const fence = /^```(\S*)\s*$/.exec(l);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i]!))
        body.push(lines[i]!);
      blocks.push({ t: "code", lang: fence[1]!, v: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length, inl: parseInline(h[2]!) });
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const prev = blocks.at(-1);
      if (prev?.t === "list" && prev.ordered === ordered)
        prev.items.push(parseInline(li[2]!));
      else blocks.push({ t: "list", ordered, items: [parseInline(li[2]!)] });
      continue;
    }
    if (l.trim() === "") flush();
    else para.push(l);
  }
  flush();
  return blocks;
}
