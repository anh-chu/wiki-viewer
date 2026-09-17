/**
 * Test-isolation guard.
 *
 * The proof suite must never touch the developer's real ~/.wiki-viewer/auth.db.
 * scripts/test-floor.mjs forces HOME + WIKI_TEST_HOME to a throwaway tmpdir via
 * src/tests/proof/preload.ts BEFORE any module loads, so lib/auth/server.js
 * freezes its DB path at an isolated location. Anything that runs a test file
 * directly (e.g. `tsx --test src/tests/proof/x.test.ts`) skips that preload —
 * historically that silently signed up test users into the live database.
 *
 * Every helper that creates users must call assertIsolatedTestHome() first;
 * without this it will throw and refuse to touch the real DB.
 */
import os from "node:os";
import path from "node:path";

export function isIsolatedTestHome(): boolean {
	const home = process.env.HOME ?? "";
	const testHome = process.env.WIKI_TEST_HOME ?? "";
	if (!testHome || !home) return false;
	if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()))) return false;
	// WIKI_TEST_HOME must be inside tmpdir too. HOME itself may be either the
	// preload's throwaway dir or a test's own nested tmpHome (e.g. wiki-put-test-*).
	if (!path.resolve(testHome).startsWith(path.resolve(os.tmpdir()))) return false;
	return true;
}

export function assertIsolatedTestHome(): void {
	if (isIsolatedTestHome()) return;
	throw new Error(
		"Test isolation broken: refusing to create test users against the real ~/.wiki-viewer auth.db. " +
			"Run tests via `pnpm test` (scripts/test-floor.mjs), or set WIKI_TEST_HOME plus HOME to " +
			"an isolated tmp dir BEFORE importing lib/auth/server.js.",
	);
}
