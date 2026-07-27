/**
 * Bootstrap admin must never promote a synthetic (non-session) user.
 *
 * requireUser() returns id "api-key" for API-key-authenticated callers. Routes
 * like /api/system/workspaces call ensureBootstrapAdmin(auth.user.id), so on a
 * FRESH install a server-to-server health check arriving before any human signs
 * in would have written "api-key" as the sole admin. The first real user to sign
 * in would then not be admin, permanently, recoverable only by hand-editing
 * config.json.
 *
 * ISOLATION: this test mutates adminUserIds, so it redirects HOME to a private
 * temp dir BEFORE importing anything that resolves configPath() via
 * os.homedir(). node:test runs files CONCURRENTLY and preload.ts gives every
 * file one shared HOME, so mutating the real config here raced
 * agent-workspace-scope.test.ts and failed it. Same trap as the earlier
 * ephemeral-root test; the fix is a private HOME, not a restore in after().
 */
import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const privateHome = mkdtempSync(path.join(tmpdir(), "admin-bootstrap-home-"));
process.env.HOME = privateHome;

// Imported AFTER HOME is redirected so configPath() resolves into privateHome.
const { ensureBootstrapAdmin, isAdmin } = await import("../../lib/auth/admin.js");
const { readConfig, updateConfig } = await import("../../lib/config.js");

after(() => {
	rmSync(privateHome, { recursive: true, force: true });
});

async function clearAdmins() {
	await updateConfig((cfg) => ({ ...cfg, adminUserIds: [] }));
}

describe("ensureBootstrapAdmin", () => {
	test("writes into the private HOME, not the shared one", async () => {
		// Guard the guard: if HOME redirection ever stops working, this test file
		// would start corrupting the shared config again and the failure would show
		// up in an unrelated file.
		await clearAdmins();
		assert.ok(
			privateHome.includes("admin-bootstrap-home-"),
			"HOME must be the private temp dir",
		);
	});

	test('refuses to promote the synthetic "api-key" user', async () => {
		await clearAdmins();
		await ensureBootstrapAdmin("api-key");
		assert.deepEqual(
			(await readConfig()).adminUserIds ?? [],
			[],
			'"api-key" must not become admin',
		);
		assert.equal(await isAdmin("api-key"), false);
	});

	test('refuses to promote the synthetic "no-auth" user', async () => {
		await clearAdmins();
		await ensureBootstrapAdmin("no-auth");
		assert.deepEqual((await readConfig()).adminUserIds ?? [], []);
	});

	test("still promotes a real session user", async () => {
		// The feature must keep working — this is a guard, not a disablement.
		await clearAdmins();
		await ensureBootstrapAdmin("real_session_user_abc");
		assert.deepEqual((await readConfig()).adminUserIds ?? [], [
			"real_session_user_abc",
		]);
		assert.equal(await isAdmin("real_session_user_abc"), true);
	});

	test("a synthetic caller does not displace an existing real admin", async () => {
		await updateConfig((cfg) => ({ ...cfg, adminUserIds: ["real_admin_1"] }));
		await ensureBootstrapAdmin("api-key");
		assert.deepEqual((await readConfig()).adminUserIds ?? [], ["real_admin_1"]);
	});
});
