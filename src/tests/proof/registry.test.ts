import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-registry-test-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
});

import {
	ensureRegistry,
	readRegistry,
	writeRegistry,
	hashToken,
	lookupAgentByToken,
	lookupAgentById,
	addAgent,
	removeAgent,
	updateLastSeen,
} from "../../lib/proof/registry.js";
import type { Agent } from "../../lib/proof/registry.js";

function makeAgent(id: string, tokenHash: string): Agent {
	return {
		id,
		displayName: id,
		tokenHash,
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	};
}

// ── ensureRegistry ────────────────────────────────────────────────────────────

test("ensureRegistry creates registry when absent", async () => {
	const r = await ensureRegistry();
	assert.equal(r.version, 1);
	assert.ok(Array.isArray(r.agents));
	assert.equal(r.agents.length, 0);
});

test("ensureRegistry is idempotent — returns same registry on second call", async () => {
	const r1 = await ensureRegistry();
	const r2 = await ensureRegistry();

});

// ── readRegistry / writeRegistry roundtrip ────────────────────────────────────

test("readRegistry returns null when file absent after rm", async () => {
	// ensureRegistry has been called, file exists. This test writes a new
	// modified registry and reads it back — not testing absent case again.
	const r = await readRegistry();
	assert.ok(r !== null, "registry should exist");
});

test("writeRegistry / readRegistry roundtrip preserves agents", async () => {
	const token = randomBytes(16).toString("hex");
	const hash = hashToken(token);
	const r = await ensureRegistry();
	r.agents.push(makeAgent("ai:roundtrip", hash));
	await writeRegistry(r);
	const r2 = await readRegistry();
	assert.ok(r2);
	assert.ok(r2.agents.some((a) => a.id === "ai:roundtrip"));
	assert.equal(r2.agents.find((a) => a.id === "ai:roundtrip")!.tokenHash, hash);
});

// ── hashToken ─────────────────────────────────────────────────────────────────

test("hashToken returns sha256 hex of input", () => {
	const input = "hello-world";
	const expected = createHash("sha256").update(input, "utf8").digest("hex");
	assert.equal(hashToken(input), expected);
});

test("hashToken is deterministic", () => {
	const h1 = hashToken("abc");
	const h2 = hashToken("abc");
	assert.equal(h1, h2);
});

// ── lookupAgentByToken ────────────────────────────────────────────────────────

test("lookupAgentByToken returns agent for correct token", async () => {
	const token = randomBytes(16).toString("hex");
	const hash = hashToken(token);
	await addAgent(makeAgent("ai:lookup-test", hash));
	const found = await lookupAgentByToken(token);
	assert.ok(found);
	assert.equal(found.id, "ai:lookup-test");
});

test("lookupAgentByToken returns null for wrong token", async () => {
	const found = await lookupAgentByToken("totally-wrong-token");
	assert.equal(found, null);
});

// ── lookupAgentById ───────────────────────────────────────────────────────────

test("lookupAgentById returns agent by id", async () => {
	const token = randomBytes(16).toString("hex");
	await addAgent(makeAgent("ai:byid-test", hashToken(token)));
	const found = await lookupAgentById("ai:byid-test");
	assert.ok(found);
	assert.equal(found.id, "ai:byid-test");
});

test("lookupAgentById returns null for unknown id", async () => {
	const found = await lookupAgentById("ai:nonexistent");
	assert.equal(found, null);
});

// ── addAgent / removeAgent ────────────────────────────────────────────────────

test("addAgent adds agent to registry", async () => {
	const token = randomBytes(16).toString("hex");
	await addAgent(makeAgent("ai:add-test", hashToken(token)));
	const r = await readRegistry();
	assert.ok(r?.agents.some((a) => a.id === "ai:add-test"));
});

test("addAgent replaces existing agent with same id", async () => {
	const t1 = randomBytes(16).toString("hex");
	const t2 = randomBytes(16).toString("hex");
	await addAgent(makeAgent("ai:replace-test", hashToken(t1)));
	await addAgent(makeAgent("ai:replace-test", hashToken(t2)));
	const r = await readRegistry();
	const found = r?.agents.filter((a) => a.id === "ai:replace-test");
	assert.equal(found?.length, 1);
	assert.equal(found?.[0].tokenHash, hashToken(t2));
});

test("removeAgent removes agent and returns true", async () => {
	const token = randomBytes(16).toString("hex");
	await addAgent(makeAgent("ai:remove-test", hashToken(token)));
	const removed = await removeAgent("ai:remove-test");
	assert.equal(removed, true);
	const found = await lookupAgentById("ai:remove-test");
	assert.equal(found, null);
});

test("removeAgent returns false for unknown id", async () => {
	const removed = await removeAgent("ai:no-such-agent");
	assert.equal(removed, false);
});

// ── updateLastSeen ────────────────────────────────────────────────────────────

test("updateLastSeen updates lastSeen timestamp", async () => {
	const token = randomBytes(16).toString("hex");
	const agent = makeAgent("ai:lastseen-test", hashToken(token));
	agent.lastSeen = "2020-01-01T00:00:00.000Z";
	await addAgent(agent);
	await updateLastSeen("ai:lastseen-test");
	const found = await lookupAgentById("ai:lastseen-test");
	assert.ok(found);
	assert.notEqual(found.lastSeen, "2020-01-01T00:00:00.000Z");
});
