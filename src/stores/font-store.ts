"use client";
import { create } from "zustand";
import {
  FONT_PRESETS,
  DEFAULT_FONT_SCALE,
  isValidFontScale,
  type FontId,
  type FontPresetId,
  type FontRole,
} from "@/lib/fonts";

interface FontState {
  ui: FontId;
  body: FontId;
  heading: FontId;
  uiScale: number;
  bodyScale: number;
  headingScale: number;
  setFont: (role: FontRole, id: FontId) => void;
  setScale: (role: FontRole, scale: number) => void;
  applyPreset: (name: FontPresetId) => void;
}

interface FontStorage {
  ui: FontId;
  body: FontId;
  heading: FontId;
  uiScale: number;
  bodyScale: number;
  headingScale: number;
}

const STORAGE_KEY = "wiki-fonts";

const DEFAULTS: FontStorage = {
  ui: "inter",
  body: "newsreader",
  heading: "fraunces",
  uiScale: DEFAULT_FONT_SCALE,
  bodyScale: DEFAULT_FONT_SCALE,
  headingScale: DEFAULT_FONT_SCALE,
};

function scaleVarName(role: FontRole): string {
  return `--font-scale-${role}`;
}

function loadInitial(): FontStorage {
  // Read from the attributes/inline styles already set by the no-flash script
  // (avoids hydration mismatch). Defaults: Classic preset at 100% scale.
  if (typeof window === "undefined") return DEFAULTS;
  const html = document.documentElement;
  const ui = (html.dataset.fontUi || DEFAULTS.ui) as FontId;
  const body = (html.dataset.fontBody || DEFAULTS.body) as FontId;
  const heading = (html.dataset.fontHeading || DEFAULTS.heading) as FontId;

  const readScale = (role: FontRole, fallback: number) => {
    const raw = html.style.getPropertyValue(scaleVarName(role));
    const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
    return isValidFontScale(parsed) ? parsed : fallback;
  };

  return {
    ui,
    body,
    heading,
    uiScale: readScale("ui", DEFAULTS.uiScale),
    bodyScale: readScale("body", DEFAULTS.bodyScale),
    headingScale: readScale("heading", DEFAULTS.headingScale),
  };
}

export const useFontStore = create<FontState>((set) => {
  const initial = loadInitial();
  return {
    ui: initial.ui,
    body: initial.body,
    heading: initial.heading,
    uiScale: initial.uiScale,
    bodyScale: initial.bodyScale,
    headingScale: initial.headingScale,

    setFont: (role, id) => {
      if (typeof window !== "undefined") {
        // Read current state from attributes as fallback
        const html = document.documentElement;
        const ui = (html.dataset.fontUi || DEFAULTS.ui) as FontId;
        const body = (html.dataset.fontBody || DEFAULTS.body) as FontId;
        const heading = (html.dataset.fontHeading || DEFAULTS.heading) as FontId;
        const current = loadInitial();

        // Update the one role being changed
        const storage: FontStorage = {
          ...current,
          ui: role === "ui" ? id : ui,
          body: role === "body" ? id : body,
          heading: role === "heading" ? id : heading,
        };

        localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
        html.dataset.fontUi = storage.ui;
        html.dataset.fontBody = storage.body;
        html.dataset.fontHeading = storage.heading;
      }

      set((state) => {
        if (role === "ui") return { ...state, ui: id };
        if (role === "body") return { ...state, body: id };
        if (role === "heading") return { ...state, heading: id };
        return state;
      });
    },

    setScale: (role, scale) => {
      if (!isValidFontScale(scale)) return;

      if (typeof window !== "undefined") {
        const html = document.documentElement;
        const current = loadInitial();
        const storage: FontStorage = {
          ...current,
          uiScale: role === "ui" ? scale : current.uiScale,
          bodyScale: role === "body" ? scale : current.bodyScale,
          headingScale: role === "heading" ? scale : current.headingScale,
        };

        localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
        html.style.setProperty(scaleVarName(role), String(scale));
      }

      set((state) => {
        if (role === "ui") return { ...state, uiScale: scale };
        if (role === "body") return { ...state, bodyScale: scale };
        if (role === "heading") return { ...state, headingScale: scale };
        return state;
      });
    },

    applyPreset: (name) => {
      const preset = FONT_PRESETS[name].fonts;
      if (typeof window !== "undefined") {
        const html = document.documentElement;
        const current = loadInitial();
        const storage: FontStorage = { ...current, ui: preset.ui, body: preset.body, heading: preset.heading };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
        html.dataset.fontUi = preset.ui;
        html.dataset.fontBody = preset.body;
        html.dataset.fontHeading = preset.heading;
      }

      set((state) => ({ ...state, ui: preset.ui, body: preset.body, heading: preset.heading }));
    },
  };
});
