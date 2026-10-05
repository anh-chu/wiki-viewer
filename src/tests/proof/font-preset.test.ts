import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FONT_PRESETS,
	FONT_PRESET_IDS,
	matchFontPreset,
	type FontId,
	type FontRole,
} from "../../lib/fonts.js";

const ROLES: FontRole[] = ["ui", "body", "heading", "code"];

test("matchFontPreset identifies each preset from its own roles", () => {
	for (const id of FONT_PRESET_IDS) {
		assert.equal(matchFontPreset(FONT_PRESETS[id].fonts), id);
	}
});

test("matchFontPreset returns null for a custom mix", () => {
	const mixed = { ...FONT_PRESETS.classic.fonts, body: "merriweather" as FontId };
	assert.equal(matchFontPreset(mixed), null);
});

test("every preset covers all four roles", () => {
	for (const id of FONT_PRESET_IDS) {
		const fonts = FONT_PRESETS[id].fonts;
		for (const role of ROLES) {
			assert.equal(typeof fonts[role], "string", `${id} is missing ${role}`);
		}
	}
});
