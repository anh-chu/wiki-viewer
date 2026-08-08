/**
 * Font system: 15 curated fonts (8 sans, 7 serif) with 3 independent roles.
 * Each font has a fully resolved CSS font-family value with fallback stacks.
 */

export type FontId =
  | "inter"
  | "satoshi"
  | "general-sans"
  | "roboto"
  | "open-sans"
  | "lexend"
  | "atkinson-hyperlegible"
  | "elms-sans"
  | "stack-sans-notch"
  | "stack-sans-text"
  | "datatype"
  | "miranda-sans"
  | "luciole"
  | "verdana"
  | "newsreader"
  | "fraunces"
  | "sentient"
  | "gambetta"
  | "merriweather"
  | "baskerville"
  | "palatino"
  | "plex-mono"
  | "jetbrains-mono"
  | "fira-code"
  | "roboto-mono"
  | "space-mono"
  | "source-code-pro";

export interface FontDef {
  id: FontId;
  label: string;
  kind: "sans" | "serif" | "mono";
  /** Fully resolved font-family CSS value, e.g. "var(--font-inter), ui-sans-serif, system-ui, sans-serif"
   *  or a literal system stack for Verdana/Palatino. */
  cssValue: string;
}

export const FONTS: Record<FontId, FontDef> = {
  // SANS (8)
  inter: {
    id: "inter",
    label: "Inter",
    kind: "sans",
    cssValue: "var(--font-inter), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  satoshi: {
    id: "satoshi",
    label: "Satoshi",
    kind: "sans",
    cssValue: "var(--font-satoshi), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "general-sans": {
    id: "general-sans",
    label: "General Sans",
    kind: "sans",
    cssValue: "var(--font-general-sans), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  roboto: {
    id: "roboto",
    label: "Roboto",
    kind: "sans",
    cssValue: "var(--font-roboto), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "open-sans": {
    id: "open-sans",
    label: "Open Sans",
    kind: "sans",
    cssValue: "var(--font-open-sans), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  lexend: {
    id: "lexend",
    label: "Lexend",
    kind: "sans",
    cssValue: "var(--font-lexend), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "atkinson-hyperlegible": {
    id: "atkinson-hyperlegible",
    label: "Atkinson Hyperlegible",
    kind: "sans",
    cssValue: "var(--font-atkinson-hyperlegible), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "elms-sans": {
    id: "elms-sans",
    label: "Elms Sans",
    kind: "sans",
    cssValue: "var(--font-elms-sans), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "stack-sans-notch": {
    id: "stack-sans-notch",
    label: "Stack Notch",
    kind: "sans",
    cssValue: "var(--font-stack-sans-notch), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "stack-sans-text": {
    id: "stack-sans-text",
    label: "Stack Text",
    kind: "sans",
    cssValue: "var(--font-stack-sans-text), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  datatype: {
    id: "datatype",
    label: "Datatype",
    kind: "sans",
    cssValue: "var(--font-datatype), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  "miranda-sans": {
    id: "miranda-sans",
    label: "Miranda Sans",
    kind: "sans",
    cssValue: "var(--font-miranda-sans), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  luciole: {
    id: "luciole",
    label: "Luciole",
    kind: "sans",
    cssValue: "var(--font-luciole), ui-sans-serif, system-ui, -apple-system, sans-serif",
  },
  verdana: {
    id: "verdana",
    label: "Verdana",
    kind: "sans",
    cssValue: "Verdana, Geneva, Tahoma, sans-serif",
  },

  // SERIF (7)
  newsreader: {
    id: "newsreader",
    label: "Newsreader",
    kind: "serif",
    cssValue: "var(--font-newsreader), Georgia, serif",
  },
  fraunces: {
    id: "fraunces",
    label: "Fraunces",
    kind: "serif",
    cssValue: "var(--font-fraunces), Georgia, serif",
  },
  sentient: {
    id: "sentient",
    label: "Sentient",
    kind: "serif",
    cssValue: "var(--font-sentient), Georgia, serif",
  },
  gambetta: {
    id: "gambetta",
    label: "Gambetta",
    kind: "serif",
    cssValue: "var(--font-gambetta), Georgia, serif",
  },
  merriweather: {
    id: "merriweather",
    label: "Merriweather",
    kind: "serif",
    cssValue: "var(--font-merriweather), Georgia, serif",
  },
  baskerville: {
    id: "baskerville",
    label: "Baskerville",
    kind: "serif",
    cssValue: "var(--font-libre-baskerville), Georgia, serif",
  },
  palatino: {
    id: "palatino",
    label: "Palatino",
    kind: "serif",
    cssValue: "Palatino Linotype, Palatino, Book Antiqua, Georgia, serif",
  },

  // MONO (6)
  "plex-mono": {
    id: "plex-mono",
    label: "IBM Plex Mono",
    kind: "mono",
    cssValue: "var(--font-plex-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  "jetbrains-mono": {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    kind: "mono",
    cssValue: "var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  "fira-code": {
    id: "fira-code",
    label: "Fira Code",
    kind: "mono",
    cssValue: "var(--font-fira-code), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  "roboto-mono": {
    id: "roboto-mono",
    label: "Roboto Mono",
    kind: "mono",
    cssValue: "var(--font-roboto-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  "space-mono": {
    id: "space-mono",
    label: "Space Mono",
    kind: "mono",
    cssValue: "var(--font-space-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  "source-code-pro": {
    id: "source-code-pro",
    label: "Source Code Pro",
    kind: "mono",
    cssValue: "var(--font-source-code-pro), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
};

export const SANS_FONT_IDS: FontId[] = [
  "inter",
  "satoshi",
  "general-sans",
  "roboto",
  "open-sans",
  "lexend",
  "atkinson-hyperlegible",
  "elms-sans",
  "stack-sans-notch",
  "stack-sans-text",
  "datatype",
  "miranda-sans",
  "luciole",
  "verdana",
];

export const MONO_FONT_IDS: FontId[] = [
  "plex-mono",
  "jetbrains-mono",
  "fira-code",
  "roboto-mono",
  "space-mono",
  "source-code-pro",
];

export const ALL_FONT_IDS: FontId[] = [
  "inter",
  "satoshi",
  "general-sans",
  "roboto",
  "open-sans",
  "lexend",
  "atkinson-hyperlegible",
  "elms-sans",
  "stack-sans-notch",
  "stack-sans-text",
  "datatype",
  "miranda-sans",
  "luciole",
  "verdana",
  "newsreader",
  "fraunces",
  "sentient",
  "gambetta",
  "merriweather",
  "baskerville",
  "palatino",
  "plex-mono",
  "jetbrains-mono",
  "fira-code",
  "roboto-mono",
  "space-mono",
  "source-code-pro",
];

export type FontRole = "ui" | "body" | "heading" | "code";

export type FontPresetId = "classic" | "modern" | "literary" | "legible" | "warm" | "stack";

export interface FontPresetDef {
  id: FontPresetId;
  label: string;
  /** One-line description of the pairing's character, shown under the preset name. */
  description: string;
  fonts: Record<FontRole, FontId>; // includes ui, body, heading, code
}

export const FONT_PRESETS: Record<FontPresetId, FontPresetDef> = {
  classic: {
    id: "classic",
    label: "Classic",
    description: "Inter, Newsreader, Fraunces — the original pairing",
    fonts: { ui: "inter", body: "newsreader", heading: "fraunces", code: "plex-mono" },
  },
  modern: {
    id: "modern",
    label: "Modern",
    description: "Satoshi, Sentient, Gambetta — clean and contemporary",
    fonts: { ui: "satoshi", body: "sentient", heading: "gambetta", code: "plex-mono" },
  },
  literary: {
    id: "literary",
    label: "Literary",
    description: "General Sans, Merriweather, Baskerville — magazine-style contrast",
    fonts: { ui: "general-sans", body: "merriweather", heading: "baskerville", code: "plex-mono" },
  },
  legible: {
    id: "legible",
    label: "Legible",
    description: "Atkinson Hyperlegible, Lexend — built for accessibility",
    fonts: { ui: "atkinson-hyperlegible", body: "atkinson-hyperlegible", heading: "lexend", code: "plex-mono" },
  },
  warm: {
    id: "warm",
    label: "Warm",
    description: "Luciole, Palatino — humanist and generously proportioned",
    fonts: { ui: "luciole", body: "palatino", heading: "palatino", code: "plex-mono" },
  },
  stack: {
    id: "stack",
    label: "Stack",
    description: "Stack Sans Text/Notch, Sentient — display headings, calm reading",
    fonts: { ui: "stack-sans-text", body: "sentient", heading: "stack-sans-notch", code: "plex-mono" },
  },
};

export const FONT_PRESET_IDS: FontPresetId[] = ["classic", "modern", "literary", "legible", "warm", "stack"];

/**
 * Per-role font SIZE control, expressed as a percentage multiplier rather than an
 * absolute px value. Each role (ui, body, heading) spans many different underlying
 * px sizes across the app (e.g. the "ui" role alone covers text-xs buttons through
 * text-2xl dialog titles), so a single absolute size wouldn't make sense — a
 * percentage scales everything under that role proportionally instead.
 */
export const DEFAULT_FONT_SCALE = 1;

export const FONT_SCALE_STEPS: number[] = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

export function isValidFontScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 2;
}
