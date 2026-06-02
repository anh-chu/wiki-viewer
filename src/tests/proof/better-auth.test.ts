import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmailAllowed } from "../../lib/auth/allowlist";

function resetEnv() {
	delete process.env.AUTH_ALLOWED_EMAILS;
	delete process.env.AUTH_ALLOWED_DOMAIN;
}

// These tests exercise the env-fallback path. They assume no allowlist is set
// in ~/.wiki-viewer/config.json (config takes precedence over env when present).

test("isEmailAllowed: no env vars allows any email", async () => {
	resetEnv();
	assert.equal(await isEmailAllowed("anyone@example.com"), true);
	assert.equal(await isEmailAllowed("eve@evil.com"), true);
});

test("isEmailAllowed: explicit allowlist (case-insensitive)", async () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = "alice@example.com,bob@example.com";
	try {
		assert.equal(await isEmailAllowed("alice@example.com"), true);
		assert.equal(await isEmailAllowed("ALICE@EXAMPLE.COM"), true);
		assert.equal(await isEmailAllowed("bob@example.com"), true);
		assert.equal(await isEmailAllowed("eve@example.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: domain allowlist", async () => {
	resetEnv();
	process.env.AUTH_ALLOWED_DOMAIN = "example.com,trusted.org";
	try {
		assert.equal(await isEmailAllowed("anyone@example.com"), true);
		assert.equal(await isEmailAllowed("user@trusted.org"), true);
		assert.equal(await isEmailAllowed("user@TRUSTED.ORG"), true);
		assert.equal(await isEmailAllowed("eve@evil.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: both lists, either match wins", async () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = "guest@anywhere.com";
	process.env.AUTH_ALLOWED_DOMAIN = "example.com";
	try {
		assert.equal(await isEmailAllowed("alice@example.com"), true);
		assert.equal(await isEmailAllowed("guest@anywhere.com"), true);
		assert.equal(await isEmailAllowed("eve@evil.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: handles whitespace and empty entries", async () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = " alice@example.com , , bob@example.com ";
	try {
		assert.equal(await isEmailAllowed("alice@example.com"), true);
		assert.equal(await isEmailAllowed("bob@example.com"), true);
		assert.equal(await isEmailAllowed("eve@example.com"), false);
	} finally {
		resetEnv();
	}
});
