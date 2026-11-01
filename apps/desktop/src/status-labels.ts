import { projectStatus, type StatusTone } from "./status-view";

/** Fixed release/support enum. Anything else, including absent, is unknown. */
export const SUPPORT_STATUSES = [
  "supported",
  "unsupported",
  "unavailable",
  "unknown",
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export interface SupportCell {
  readonly id: string;
  readonly label: string;
  readonly status: SupportStatus;
  /** Runs behind the claim; 0 means never run. */
  readonly runs?: number;
}

export interface SupportView {
  readonly label: string;
  readonly tone: StatusTone;
}

const SUPPORT_VIEWS: Readonly<
  Record<Exclude<SupportStatus, "unknown">, SupportView>
> = Object.freeze({
  supported: { label: "Supported", tone: "positive" },
  unsupported: { label: "Unsupported", tone: "negative" },
  unavailable: { label: "Unavailable", tone: "warning" },
});

/** Pure enum -> label. Unrecognised input is shown as Unknown, never Supported. */
export function supportView(status: unknown): SupportView {
  if (typeof status === "string" && Object.hasOwn(SUPPORT_VIEWS, status)) {
    return SUPPORT_VIEWS[status as keyof typeof SUPPORT_VIEWS];
  }
  // Reuse the shared projection's Unknown rather than a second table.
  return projectStatus("run", null);
}

/** A supported claim needs a positive, whole run count behind it. */
export function supportCellView(
  cell: Pick<SupportCell, "status" | "runs">,
): SupportView {
  const view = supportView(cell.status);
  if (cell.status !== "supported") return view;
  if (
    typeof cell.runs === "number" &&
    Number.isInteger(cell.runs) &&
    cell.runs > 0
  ) {
    return view;
  }
  return projectStatus("run", null);
}

/** Invalid counts are not evidence; render them as missing, not as n=NaN. */
export function formatRuns(runs: unknown): string {
  if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 0) {
    return "not reported";
  }
  return `n=${runs}`;
}
