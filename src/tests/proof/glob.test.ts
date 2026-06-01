import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGlob } from "../../lib/proof/glob.js";

// ── ** matches ────────────────────────────────────────────────────────────────

test("** matches file in root", () => {
	assert.ok(matchGlob("**/*", "notes.md"));
});

test("** matches file in subdirectory", () => {
	assert.ok(matchGlob("**/*", "work/notes.md"));
});

test("** matches deeply nested file", () => {
	assert.ok(matchGlob("**/*", "a/b/c/d/notes.md"));
});

test("**/*.md matches only .md files at any depth", () => {
	assert.ok(matchGlob("**/*.md", "notes.md"));
	assert.ok(matchGlob("**/*.md", "work/notes.md"));
	assert.ok(matchGlob("**/*.md", "a/b/notes.md"));
	assert.ok(!matchGlob("**/*.md", "notes.txt"));
	assert.ok(!matchGlob("**/*.md", "work/notes.txt"));
});

test("** matches zero path segments (root file)", () => {
	assert.ok(matchGlob("**/*", "root.md"));
});

// ── * does not cross / ────────────────────────────────────────────────────────

test("* does not match path separator", () => {
	assert.ok(!matchGlob("*.md", "work/notes.md"));
	assert.ok(matchGlob("*.md", "notes.md"));
});

test("* matches empty string at same level", () => {
	assert.ok(matchGlob("notes*", "notes.md"));
	assert.ok(matchGlob("notes*", "notes"));
	assert.ok(!matchGlob("notes*", "a/notes.md"));
});

// ── ? matches single non-slash char ──────────────────────────────────────────

test("? matches single character", () => {
	assert.ok(matchGlob("note?.md", "notes.md"));
	assert.ok(matchGlob("note?.md", "notex.md"));
	assert.ok(!matchGlob("note?.md", "notexy.md"));
	assert.ok(!matchGlob("note?.md", "work/notes.md"));
});

// ── Literal match ─────────────────────────────────────────────────────────────

test("Literal pattern matches exact path", () => {
	assert.ok(matchGlob("notes/work.md", "notes/work.md"));
	assert.ok(!matchGlob("notes/work.md", "notes/other.md"));
});

test("Literal pattern anchored — no partial match", () => {
	assert.ok(!matchGlob("notes", "notes/work.md"));
	assert.ok(!matchGlob("notes.md", "xnotes.md"));
});

// ── Prefix patterns ───────────────────────────────────────────────────────────

test("work/** matches files under work/", () => {
	assert.ok(matchGlob("work/**", "work/notes.md"));
	assert.ok(matchGlob("work/**", "work/sub/notes.md"));
	assert.ok(!matchGlob("work/**", "other/notes.md"));
	assert.ok(!matchGlob("work/**", "notes.md"));
});

// ── Regex special char escaping ────────────────────────────────────────────────

test("Dots in pattern treated as literal", () => {
	// notes.md pattern: dot is literal, must not match notesXmd
	assert.ok(matchGlob("notes.md", "notes.md"));
	assert.ok(!matchGlob("notes.md", "notesXmd"));
	// Pattern without dots matches its own literal value
	assert.ok(matchGlob("notesXmd", "notesXmd"));
});
