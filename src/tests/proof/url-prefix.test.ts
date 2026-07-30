/**
 * url-prefix.test.ts — apiUrl() and isLite() contract.
 *
 * apiUrl() must be identity when the prefix is unset, idempotent when set,
 * and leave http(s):// and relative inputs alone.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Reset module-level state between tests by reloading the module.
let apiUrl: (path: string) => string;
let isLite: () => boolean;

async function reloadModule() {
	const mod = await import("../../lib/url-prefix.js");
	apiUrl = mod.apiUrl;
	isLite = mod.isLite;
}

// Simulate browser: set window globals.
function setWindow(prefix?: string, lite?: boolean) {
	(globalThis as unknown as { window?: Record<string, unknown> }).window = {
		__WIKI_PREFIX: prefix,
		__WIKI_LITE: lite,
	};
}

function clearWindow() {
	delete (globalThis as unknown as { window?: unknown }).window;
}

describe("apiUrl identity (no prefix)", () => {
	beforeEach(async () => {
		clearWindow();
		delete process.env.WIKI_URL_PREFIX;
		await reloadModule();
	});

	test("returns path unchanged", () => {
		assert.equal(apiUrl("/api/wiki"), "/api/wiki");
		assert.equal(apiUrl("/icon-192.png"), "/icon-192.png");
		assert.equal(apiUrl("/"), "/");
	});

	test("passes through non-/ inputs", () => {
		assert.equal(apiUrl("https://example.com"), "https://example.com");
		assert.equal(apiUrl("../relative"), "../relative");
		assert.equal(apiUrl("api/wiki"), "api/wiki");
	});
});

describe("apiUrl with prefix", () => {
	beforeEach(async () => {
		clearWindow();
		delete process.env.WIKI_URL_PREFIX;
		setWindow("/wiki");
		await reloadModule();
	});

	afterEach(() => {
		clearWindow();
	});

	test("prepends prefix to /-starting paths", () => {
		assert.equal(apiUrl("/api/wiki"), "/wiki/api/wiki");
		assert.equal(apiUrl("/icon-192.png"), "/wiki/icon-192.png");
		assert.equal(apiUrl("/"), "/wiki/");
	});

	test("idempotent: already-prefixed paths unchanged", () => {
		assert.equal(apiUrl("/wiki/api/wiki"), "/wiki/api/wiki");
		assert.equal(apiUrl("/wiki/icon-192.png"), "/wiki/icon-192.png");
		assert.equal(apiUrl("/wiki/"), "/wiki/");
	});

	test("does not mangle non-/ inputs", () => {
		assert.equal(apiUrl("https://example.com"), "https://example.com");
		assert.equal(apiUrl("../relative"), "../relative");
	});
});

describe("apiUrl server-side prefix (process.env)", () => {
	beforeEach(async () => {
		clearWindow();
		process.env.WIKI_URL_PREFIX = "/wiki";
		await reloadModule();
	});

	afterEach(() => {
		delete process.env.WIKI_URL_PREFIX;
	});

	test("prepends prefix from process.env", () => {
		assert.equal(apiUrl("/api/wiki"), "/wiki/api/wiki");
	});

	test("idempotent", () => {
		assert.equal(apiUrl("/wiki/api/wiki"), "/wiki/api/wiki");
	});
});

describe("isLite", () => {
	beforeEach(async () => {
		clearWindow();
		delete process.env.WIKI_LITE;
		await reloadModule();
	});

	test("false when unset", () => {
		assert.equal(isLite(), false);
	});

	test("true in browser when window.__WIKI_LITE === true", async () => {
		setWindow(undefined, true);
		await reloadModule();
		assert.equal(isLite(), true);
	});

	test("true on server when WIKI_LITE=1", async () => {
		clearWindow();
		process.env.WIKI_LITE = "1";
		await reloadModule();
		assert.equal(isLite(), true);
	});
});
