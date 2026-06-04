/**
 * Phase E — cross-workspace isolation (the "no bleed" contract).
 *
 * Two workspaces (different rootDirs) that contain the SAME relative path must
 * not share in-memory state:
 *   - edit leases (lease.ts is keyed by ns=rootDir)
 *   - collab-state revision / active flag
 *   - sidecars (live under <rootDir>/.proof/, naturally isolated)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	setLease,
	hasActiveLease,
	clearLease,
	leaseGeneration,
	_resetLeaseStore,
} from "../../lib/proof/lease.js";
import { computeCollabState } from "../../lib/proof/collab-state.js";
import { writeSidecar, emptySidecar } from "../../lib/proof/sidecar.js";

let rootA: string;
let rootB: string;

before(async () => {
	rootA = await mkdtemp(path.join(tmpdir(), "wsiso-A-"));
	rootB = await mkdtemp(path.join(tmpdir(), "wsiso-B-"));
	_resetLeaseStore();
});

after(async () => {
	await rm(rootA, { recursive: true, force: true });
	await rm(rootB, { recursive: true, force: true });
});

const REL = "notes.md";

test("lease on (rootA, notes.md) does NOT make (rootB, notes.md) active", () => {
	setLease(rootA, REL, "user:alice");
	assert.equal(hasActiveLease(rootA, REL), true);
	assert.equal(hasActiveLease(rootB, REL), false, "workspace B must be unaffected");
	clearLease(rootA, REL, "user:alice");
	assert.equal(hasActiveLease(rootA, REL), false);
});

test("lease generation counters are independent per workspace", () => {
	const genA0 = leaseGeneration(rootA, REL);
	const genB0 = leaseGeneration(rootB, REL);
	// Bump A twice (open/close), leave B untouched.
	setLease(rootA, REL, "user:alice");
	clearLease(rootA, REL, "user:alice");
	assert.equal(leaseGeneration(rootA, REL), genA0 + 2);
	assert.equal(leaseGeneration(rootB, REL), genB0, "B generation must not move");
});

test("computeCollabState: human lease in A is 'active' only in A", async () => {
	// Same relpath, a sidecar with one comment in BOTH workspaces would be
	// 'active'; here neither has artifacts, so state is driven purely by lease.
	await mkdir(path.join(rootA, ".proof"), { recursive: true });
	await mkdir(path.join(rootB, ".proof"), { recursive: true });

	setLease(rootA, REL, "user:alice");
	const a = await computeCollabState(rootA, REL);
	const b = await computeCollabState(rootB, REL);
	assert.equal(a.state, "active", "A has a live human lease");
	assert.equal(b.state, "untracked", "B has no lease, no sidecar");
	clearLease(rootA, REL, "user:alice");
});

test("sidecars are isolated by rootDir (same relpath, different content)", async () => {
	const scA = emptySidecar(REL);
	scA.revision = 7;
	const scB = emptySidecar(REL);
	scB.revision = 99;
	await writeSidecar(rootA, REL, scA);
	await writeSidecar(rootB, REL, scB);

	const a = await computeCollabState(rootA, REL);
	const b = await computeCollabState(rootB, REL);
	// revision = sidecar.revision + leaseGeneration(ns); leases cleared above.
	assert.equal(a.revision - leaseGeneration(rootA, REL), 7);
	assert.equal(b.revision - leaseGeneration(rootB, REL), 99);
});
