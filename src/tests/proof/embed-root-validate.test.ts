/**
 * The shared ?root= validator used by BOTH middleware (page navigation) and
 * workspace-context (API routes), so the two can never disagree about whether a
 * root is valid or which code describes the failure.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateRootParam } from "../../lib/embed-root.js";
import { resolveWorkspaceForAgent } from "../../lib/workspace-context.js";
import { ensureApiKey } from "../../lib/auth/api-key.js";

let dir: string;
let file: string;
let API_KEY: string;
const savedNoAuth = process.env.WIKI_NO_AUTH;

before(async () => {
	delete process.env.WIKI_NO_AUTH;
	dir = await mkdtemp(path.join(tmpdir(), "embroot-"));
	file = path.join(dir, "f.md");
	await writeFile(file, "x");
	API_KEY = ensureApiKey();
});

after(async () => {
	if (savedNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = savedNoAuth;
	await rm(dir, { recursive: true, force: true });
});

describe("validateRootParam", () => {
	test("directory -> ok, path.resolve'd", () => {
		const r = validateRootParam(dir);
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.rootDir, path.resolve(dir));
	});

	test("relative input is resolved to absolute", () => {
		const r = validateRootParam(".");
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(path.isAbsolute(r.rootDir), true);
	});

	test("missing path -> root_not_found", () => {
		const r = validateRootParam(path.join(dir, "nope", "deeper"));
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "root_not_found");
	});

	test("file -> root_not_a_directory", () => {
		const r = validateRootParam(file);
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.code, "root_not_a_directory");
	});
});

describe("page-nav and API validation agree", () => {
	// Regression guard for the gap termyard found empirically: ?root= was
	// validated in the API routes but NOT on page navigation, so a bad root
	// rendered the shell with HTTP 200 and the host saw no error. Both paths now
	// call validateRootParam, so the codes must match exactly.
	for (const [label, badRoot, expected] of [
		["missing dir", "__MISSING__", "root_not_found"],
		["file as root", "__FILE__", "root_not_a_directory"],
	] as const) {
		test(`${label}: same code from validator and resolver`, async () => {
			const target = badRoot === "__FILE__" ? file : path.join(dir, "nope");

			const direct = validateRootParam(target);
			assert.equal(direct.ok, false);
			if (direct.ok) return;

			const viaResolver = await resolveWorkspaceForAgent(
				new Request(
					`http://localhost:3000/api/wiki?root=${encodeURIComponent(target)}`,
					{ headers: { authorization: `Bearer ${API_KEY}` } },
				),
			);
			assert.equal(viaResolver.ok, false);
			if (viaResolver.ok) return;

			assert.equal(direct.code, expected);
			assert.equal(viaResolver.code, expected);
			assert.equal(viaResolver.status, 400);
		});
	}
});
