/**
 * middleware-lite-deny.test.ts — WIKI_LITE=1 deny list.
 *
 * Contract:
 *   - With WIKI_LITE=1, /api/system/workspaces and /s/abc are 404.
 *   - /api/wiki and / pass through.
 *   - With WIKI_LITE unset, all pass.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { middleware } from "../../middleware.js";

const savedLite = process.env.WIKI_LITE;
const savedNoAuth = process.env.WIKI_NO_AUTH;

function req(pathname: string): Request {
	const url = `http://localhost:3000${pathname}`;
	return new Request(url);
}

before(() => {
	process.env.WIKI_NO_AUTH = "1";
});

after(() => {
	if (savedLite === undefined) delete process.env.WIKI_LITE;
	else process.env.WIKI_LITE = savedLite;
	if (savedNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = savedNoAuth;
});

describe("WIKI_LITE=1 deny list", () => {
	before(() => {
		process.env.WIKI_LITE = "1";
	});

	after(() => {
		delete process.env.WIKI_LITE;
	});

	test("/api/system/workspaces -> 404", () => {
		// middleware returns NextResponse; assert status via the response object.
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/api/system/workspaces"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 404);
	});

	test("/s/abc -> 404", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/s/abc"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 404);
	});

	test("/api/agent -> 404", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/api/agent"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 404);
	});

	test("/api/share -> 404", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/api/share"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 404);
	});

	test("/signin -> 404", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/signin"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 404);
	});

	test("/api/wiki -> 200 (passthrough)", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/api/wiki"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 200);
	});

	test("/ -> 200 (passthrough)", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 200);
	});
});

describe("WIKI_LITE unset: all routes pass", () => {
	before(() => {
		delete process.env.WIKI_LITE;
	});

	test("/api/system/workspaces -> 200", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/api/system/workspaces"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 200);
	});

	test("/s/abc -> 200", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/s/abc"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 200);
	});

	test("/signin -> 200", () => {
		const res = middleware({
			nextUrl: new URL("http://localhost:3000/signin"),
			cookies: { get: () => undefined },
		} as Parameters<typeof middleware>[0]);
		assert.equal(res.status, 200);
	});
});
