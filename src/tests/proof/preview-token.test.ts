/**
 * Preview capability token tests.
 *
 * The token is the authorization a sandboxed HTML preview's nested frames use
 * in place of cookies, so these assert the two things that would make it a
 * vulnerability rather than a capability: that a forged/expired token is
 * rejected, and that a token scoped to one directory cannot read a sibling.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "preview-token-test-"));
	process.env.HOME = tmpHome;
});

test("round-trips the scope it was issued for", async () => {
	const { issuePreviewToken, verifyPreviewToken } = await import("@/lib/preview-token");
	const { token } = issuePreviewToken({ rootDir: "/tmp/ws", prefix: "docs" });
	const scope = verifyPreviewToken(token);
	assert.deepEqual(scope, { rootDir: "/tmp/ws", prefix: "docs" });
});

test("rejects a tampered payload and a tampered signature", async () => {
	const { issuePreviewToken, verifyPreviewToken } = await import("@/lib/preview-token");
	const { token } = issuePreviewToken({ rootDir: "/tmp/ws", prefix: "docs" });
	const [body, sig] = token.split(".");

	// Re-point the payload at a different root, keeping the original signature.
	const forgedBody = Buffer.from(JSON.stringify({ rootDir: "/etc", prefix: "", exp: Date.now() + 60_000 }))
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	assert.equal(verifyPreviewToken(`${forgedBody}.${sig}`), null);
	assert.equal(verifyPreviewToken(`${body}.${sig.slice(0, -1)}a`), null);
	assert.equal(verifyPreviewToken("garbage"), null);
	assert.equal(verifyPreviewToken(""), null);
});

test("rejects an expired token", async () => {
	const { issuePreviewToken, verifyPreviewToken, PREVIEW_TOKEN_TTL_MS } = await import("@/lib/preview-token");
	const now = Date.now();
	const { token, expiresAt } = issuePreviewToken({ rootDir: "/tmp/ws", prefix: "" }, now);
	assert.equal(expiresAt, now + PREVIEW_TOKEN_TTL_MS);
	assert.notEqual(verifyPreviewToken(token, now), null);
	assert.equal(verifyPreviewToken(token, expiresAt + 1), null);
});

test("scopes to the previewed file's directory, never the whole workspace", async () => {
	const { previewPrefixFor, withinPreviewPrefix } = await import("@/lib/preview-token");
	assert.equal(previewPrefixFor("docs/a.html"), "docs");
	assert.equal(previewPrefixFor("site/nested/a.html"), "site/nested");
	assert.equal(previewPrefixFor("top.html"), "");
	assert.equal(previewPrefixFor("/docs/a.html"), "docs");

	// A file in the scoped directory (and below it) is in; a sibling is not.
	assert.equal(withinPreviewPrefix("docs", "docs/a.html"), true);
	assert.equal(withinPreviewPrefix("docs", "docs/deep/b.css"), true);
	assert.equal(withinPreviewPrefix("docs", "docs"), true);
	assert.equal(withinPreviewPrefix("docs", "secrets/.env"), false);
	assert.equal(withinPreviewPrefix("docs", "docs2/a.html"), false);
	// A root-level preview (the app's own directory) may read the whole root.
	assert.equal(withinPreviewPrefix("", "anything/at/all"), true);
});
