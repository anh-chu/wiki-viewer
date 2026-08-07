"use client";
import { create } from "zustand";
import { FONT_PRESETS, type FontId, type FontRole, ALL_FONT_IDS } from "@/lib/fonts";

interface FontState {
  ui: FontId;
  body: FontId;
  heading: FontId;
  setFont: (role: FontRole, id: FontId) => void;
  applyPreset: (name: "classic" | "modern") => void;
}

interface FontStorage {
  ui: FontId;
  body: FontId;
  heading: FontId;
}

const STORAGE_KEY = "wiki-fonts";

function loadInitial(): FontStorage {
  // Read from the attributes already set by the no-flash script (avoids hydration mismatch).
  // Defaults: Classic preset (Inter UI, Newsreader body, Fraunces heading).
  if (typeof window === "undefined") {
    return { ui: "inter", body: "newsreader", heading: "fraunces" };
  }
  const html = document.documentElement;
  const ui = (html.dataset.fontUi || "inter") as FontId;
  const body = (html.dataset.fontBody || "newsreader") as FontId;
  const heading = (html.dataset.fontHeading || "fraunces") as FontId;
  return { ui, body, heading };
}

function parseStorage(): FontStorage {
  // Parse stored JSON or return defaults (classic preset)
  try {
    if (typeof window === "undefined") return { ui: "inter", body: "newsreader", heading: "fraunces" };
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ui: "inter", body: "newsreader", heading: "fraunces" };
    const parsed = JSON.parse(stored) as FontStorage;
    return {
      ui: ALL_FONT_IDS.includes(parsed.ui) ? parsed.ui : "inter",
      body: ALL_FONT_IDS.includes(parsed.body) ? parsed.body : "newsreader",
      heading: ALL_FONT_IDS.includes(parsed.heading) ? parsed.heading : "fraunces",
    };
  } catch {
    return { ui: "inter", body: "newsreader", heading: "fraunces" };
  }
}

export const useFontStore = create<FontState>((set) => {
  const initial = loadInitial();
  return {
    ui: initial.ui,
    body: initial.body,
    heading: initial.heading,

    setFont: (role, id) => {
      if (typeof window !== "undefined") {
        // Read current state from attributes or parseStorage as fallback
        const ui = (document.documentElement.dataset.fontUi || "inter") as FontId;
        const body = (document.documentElement.dataset.fontBody || "newsreader") as FontId;
        const heading = (document.documentElement.dataset.fontHeading || "fraunces") as FontId;

        // Update the one role being changed
        const storage: FontStorage =
          role === "ui"
            ? { ui: id, body, heading }
            : role === "body"
              ? { ui, body: id, heading }
              : { ui, body, heading: id };

        localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
        document.documentElement.dataset.fontUi = storage.ui;
        document.documentElement.dataset.fontBody = storage.body;
        document.documentElement.dataset.fontHeading = storage.heading;
      }

      set((state) => {
        if (role === "ui") return { ...state, ui: id };
        if (role === "body") return { ...state, body: id };
        if (role === "heading") return { ...state, heading: id };
        return state;
      });
    },

    applyPreset: (name) => {
      if (typeof window !== "undefined") {
        const preset = FONT_PRESETS[name];
        const storage: FontStorage = { ui: preset.ui, body: preset.body, heading: preset.heading };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
        document.documentElement.dataset.fontUi = preset.ui;
        document.documentElement.dataset.fontBody = preset.body;
        document.documentElement.dataset.fontHeading = preset.heading;
      }

      set((state) => {
        const preset = FONT_PRESETS[name];
        return { ...state, ui: preset.ui, body: preset.body, heading: preset.heading };
      });
    },
  };
});
