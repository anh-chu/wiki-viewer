#!/usr/bin/env node
/**
 * Remove test-fixture users from an auth.db (default ~/.wiki-viewer/auth.db).
 *
 * Matches ONLY the fixture email shapes created by src/tests/proof:
 *   - anything @test.local (t<ts>…, put<ts>…, font-debug2@…)
 *   - 'test@test.com', 'font-debug2@test.local', 'livetest@example.com'
 *
 * Usage:
 *   node scripts/clean-auth-test-users.mjs [--db <path>] [--purge]
 * Without --purge it is a dry run.
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import process from "node:process";

const args = process.argv.slice(2);
const dbArg = args.indexOf("--db");
const dbPath = dbArg !== -1 ? args[dbArg + 1] : `${os.homedir()}/.wiki-viewer/auth.db`;
const purge = args.includes("--purge");

const db = new DatabaseSync(dbPath);

const TEST_EMAILS_SQL = `email LIKE '%@test.local'
	OR email IN ('test@test.com', 'font-debug2@test.local', 'livetest@example.com')`;

const users = [...db.prepare(`SELECT id, email, name, createdAt FROM user WHERE ${TEST_EMAILS_SQL}`).iterate()];
const count = (sql) => db.prepare(sql).get().n;

console.log(`db: ${dbPath}`);
console.log(`capture: test users found: ${users.length}`);
for (const u of users) console.log(`  - ${u.email} (${u.createdAt})`);
console.log(
	`capture: dependent rows: ${JSON.stringify({
		account: count(`SELECT COUNT(*) n FROM account WHERE userId IN (SELECT id FROM user WHERE ${TEST_EMAILS_SQL})`),
		session: count(`SELECT COUNT(*) n FROM session WHERE userId IN (SELECT id FROM user WHERE ${TEST_EMAILS_SQL})`),
		user: users.length,
	})}`,
);

if (!purge) {
	db.close();
	console.log("dry run (no --purge); nothing deleted");
	process.exit(0);
}

db.exec("BEGIN");
try {
	const s = db.prepare(`DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE ${TEST_EMAILS_SQL})`).run();
	const a = db.prepare(`DELETE FROM account WHERE userId IN (SELECT id FROM user WHERE ${TEST_EMAILS_SQL})`).run();
	const u = db.prepare(`DELETE FROM user WHERE ${TEST_EMAILS_SQL}`).run();
	db.exec("COMMIT");
	console.log(`deleted: session=${s.changes} account=${a.changes} user=${u.changes}`);
} catch (err) {
	db.exec("ROLLBACK");
	db.close();
	throw err;
}

const remaining = count(`SELECT COUNT(*) n FROM user WHERE ${TEST_EMAILS_SQL}`);
if (remaining !== 0) {
	console.error(`verify: FAILED — ${remaining} test users remain`);
	db.close();
	process.exit(1);
}
const total = count("SELECT COUNT(*) n FROM user");
console.log(`verify: ok — 0 test users remain, ${total} users total`);
db.close();
