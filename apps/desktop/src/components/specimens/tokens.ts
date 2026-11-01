// Semantic token specimens (TD-75). Selection values are the follow-up proposal
// pending MdSiddiqx sign-off; consumers must read tokens, never hard-code colours.
export const CONCRETE_THEMES = ["light", "dark", "high-contrast"] as const;
export type ConcreteTheme = (typeof CONCRETE_THEMES)[number];

export const THEMES = ["light", "dark", "system", "high-contrast"] as const;
export type ThemeName = (typeof THEMES)[number];

// TD-75 follow-up: retune selection in one place; values need design sign-off.
export const PROPOSED_SELECTION = {
  selection: "#1d72c8",
  selectionText: "#ffffff",
} as const;

export const TOKEN_NAMES = [
  "surface",
  "surfaceRaised",
  "text",
  "textMuted",
  "border",
  "focus",
  "selection",
  "selectionText",
  "danger",
  "pending",
  "positive",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type TokenSheet = Readonly<Record<TokenName, string>>;

export const TOKENS: Readonly<Record<ConcreteTheme, TokenSheet>> =
  Object.freeze({
    light: {
      surface: "#ffffff",
      surfaceRaised: "#f3f3f3",
      text: "#1a1a1a",
      textMuted: "#595959",
      border: "#767676",
      focus: "#005fb8",
      selection: PROPOSED_SELECTION.selection,
      selectionText: PROPOSED_SELECTION.selectionText,
      danger: "#b00020",
      pending: "#8a5a00",
      positive: "#1b6e3c",
    },
    dark: {
      surface: "#1e1e1e",
      surfaceRaised: "#2b2b2b",
      text: "#f0f0f0",
      textMuted: "#b3b3b3",
      border: "#8c8c8c",
      focus: "#60cdff",
      selection: PROPOSED_SELECTION.selection,
      selectionText: PROPOSED_SELECTION.selectionText,
      danger: "#ff8a8a",
      pending: "#e5b45a",
      positive: "#6fcf97",
    },
    "high-contrast": {
      surface: "#000000",
      surfaceRaised: "#000000",
      text: "#ffffff",
      textMuted: "#ffffff",
      border: "#ffffff",
      focus: "#ffff00",
      selection: "#1aebff",
      selectionText: "#000000",
      danger: "#ff9d9d",
      pending: "#ffff00",
      positive: "#7dff7d",
    },
  });

export interface ThemePreference {
  readonly prefersDark?: boolean;
  readonly forcedColors?: boolean;
}

export function resolveTheme(
  theme: ThemeName,
  preference: ThemePreference = {},
): ConcreteTheme {
  if (preference.forcedColors) return "high-contrast";
  if (theme !== "system") return theme;
  return preference.prefersDark ? "dark" : "light";
}

export interface ContrastPair {
  readonly fg: TokenName;
  readonly bg: TokenName;
  /** WCAG AA: 4.5 for text, 3 for non-text indicators. */
  readonly min: number;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "text", bg: "surface", min: 4.5 },
  { fg: "text", bg: "surfaceRaised", min: 4.5 },
  { fg: "textMuted", bg: "surface", min: 4.5 },
  { fg: "selectionText", bg: "selection", min: 4.5 },
  { fg: "selection", bg: "surface", min: 3 },
  { fg: "danger", bg: "surface", min: 4.5 },
  { fg: "pending", bg: "surface", min: 4.5 },
  { fg: "positive", bg: "surface", min: 4.5 },
  { fg: "focus", bg: "surface", min: 3 },
  { fg: "border", bg: "surface", min: 3 },
];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`bad colour ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
