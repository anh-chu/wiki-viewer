/**
 * Test preload — runs before any test module is imported (via `tsx --import`).
 *
 * auth/server.ts resolves the SQLite DB path from $HOME at module-load time.
 * Several test files import route handlers (and thus auth/server) at the top of
 * the file, before their before() hook can override HOME. Without this preload
 * those imports freeze the DB path to the real ~/.wiki-viewer/auth.db and the
 * suite writes thousands of @test.local users into it.
 *
 * Forcing HOME to a throwaway tmp dir here, before anything else loads,
 * guarantees every test run is isolated from the developer's real config.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.WIKI_TEST_HOME) {
	const home = mkdtempSync(path.join(tmpdir(), "wiki-test-home-"));
	process.env.HOME = home;
	process.env.WIKI_TEST_HOME = home;
}
