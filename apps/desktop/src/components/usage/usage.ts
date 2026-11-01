export type UsageSemantics = "reported" | "estimated" | "unavailable";

export interface UsageInput {
  readonly semantics: UsageSemantics;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costUsd?: number | null;
}

export interface UsageRow {
  readonly label: string;
  readonly value: string;
}

const valid = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Rows for numbers that are actually present; never invents a zero. */
export function usageRows(usage: UsageInput): readonly UsageRow[] {
  if (usage.semantics === "unavailable") return [];
  const rows: UsageRow[] = [];
  if (valid(usage.inputTokens))
    rows.push({
      label: "Input tokens",
      value: usage.inputTokens.toLocaleString("en-US"),
    });
  if (valid(usage.outputTokens))
    rows.push({
      label: "Output tokens",
      value: usage.outputTokens.toLocaleString("en-US"),
    });
  if (valid(usage.costUsd))
    rows.push({ label: "Cost", value: `$${usage.costUsd.toFixed(4)}` });
  return rows;
}
