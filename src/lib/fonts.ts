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
  | "palatino";

export interface FontDef {
  id: FontId;
  label: string;
  kind: "sans" | "serif";
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
];

export type FontRole = "ui" | "body" | "heading";

export const FONT_PRESETS: Record<"classic" | "modern", Record<FontRole, FontId>> = {
  classic: { ui: "inter", body: "newsreader", heading: "fraunces" },
  modern: { ui: "satoshi", body: "sentient", heading: "gambetta" },
};
