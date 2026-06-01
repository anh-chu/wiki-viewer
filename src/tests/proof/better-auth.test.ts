import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmailAllowed } from "../../lib/auth/allowlist";

function resetEnv() {
	delete process.env.AUTH_ALLOWED_EMAILS;
	delete process.env.AUTH_ALLOWED_DOMAIN;
}

test("isEmailAllowed: no env vars allows any email", () => {
	resetEnv();
	assert.equal(isEmailAllowed("anyone@example.com"), true);
	assert.equal(isEmailAllowed("eve@evil.com"), true);
});

test("isEmailAllowed: explicit allowlist (case-insensitive)", () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = "alice@example.com,bob@example.com";
	try {
		assert.equal(isEmailAllowed("alice@example.com"), true);
		assert.equal(isEmailAllowed("ALICE@EXAMPLE.COM"), true);
		assert.equal(isEmailAllowed("bob@example.com"), true);
		assert.equal(isEmailAllowed("eve@example.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: domain allowlist", () => {
	resetEnv();
	process.env.AUTH_ALLOWED_DOMAIN = "example.com,trusted.org";
	try {
		assert.equal(isEmailAllowed("anyone@example.com"), true);
		assert.equal(isEmailAllowed("user@trusted.org"), true);
		assert.equal(isEmailAllowed("user@TRUSTED.ORG"), true);
		assert.equal(isEmailAllowed("eve@evil.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: both lists, either match wins", () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = "guest@anywhere.com";
	process.env.AUTH_ALLOWED_DOMAIN = "example.com";
	try {
		assert.equal(isEmailAllowed("alice@example.com"), true);
		assert.equal(isEmailAllowed("guest@anywhere.com"), true);
		assert.equal(isEmailAllowed("eve@evil.com"), false);
	} finally {
		resetEnv();
	}
});

test("isEmailAllowed: handles whitespace and empty entries", () => {
	resetEnv();
	process.env.AUTH_ALLOWED_EMAILS = " alice@example.com , , bob@example.com ";
	try {
		assert.equal(isEmailAllowed("alice@example.com"), true);
		assert.equal(isEmailAllowed("bob@example.com"), true);
		assert.equal(isEmailAllowed("eve@example.com"), false);
	} finally {
		resetEnv();
	}
});
