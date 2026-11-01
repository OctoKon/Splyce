/**
 * Named TD-29 presentation cases used by the e2e fixture page.
 *
 * They are renderer snapshots only: no engine, planner or package manager is
 * involved, and none of them is evidence of installed bytes or releases.
 */
export type Td29Case =
  | "d1-setup"
  | "d6-setup"
  | "d6-stale"
  | "w10-modules"
  | "w10-ready"
  | "offline-modules"
  | "unavailable-modules";

export const TD29_CASES: readonly Td29Case[] = [
  "d1-setup",
  "d6-setup",
  "d6-stale",
  "w10-modules",
  "w10-ready",
  "offline-modules",
  "unavailable-modules",
];

export function isTd29Case(value: string): value is Td29Case {
  return (TD29_CASES as readonly string[]).includes(value);
}
