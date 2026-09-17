/**
 * Service-token bootstrap registration.
 *
 * POST /api/agent/register with a valid X-Service-Token auto-approves:
 * 200 { status:"approved", agentId, token } — no pending, no polling, no UI.
 * Invalid/missing header → legacy TOFU 202 pending flow.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "svc-token-test-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
});

import { POST as registerPOST } from "../../app/api/agent/register/route.js";
import { ensureServiceToken, getServiceToken } from "../../lib/auth/service-token.js";
import { lookupAgentById } from "../../lib/proof/registry.js";
import { ensureRegistry } from "../../lib/proof/registry.js";

beforeEach(async () => {
	const { _resetRegisterBuckets } = await import("../../lib/proof/register-rate-limit");
	_resetRegisterBuckets();
});

const SCOPE = { paths: ["**/*"], ops: ["read"] };

function makeReq(id = "ai:svcbot", headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/agent/register", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			id,
			displayName: "Service Bot",
			scope: SCOPE,
		}),
	});
}

test("valid service token → 200 approved with token, agent stored with requested scope", async () => {
	ensureServiceToken();
	const svc = getServiceToken();

	const res = await registerPOST(
		makeReq("ai:svcbot", { "X-Service-Token": svc }),
	);
	assert.equal(res.status, 200);
	const data = (await res.json()) as {
		status: string;
		agentId: string;
		token: string;
	};
	assert.equal(data.status, "approved");
	assert.equal(data.agentId, "ai:svcbot");
	assert.ok(data.token.length >= 32, "token present");

	// Agent exists in registry with the requested scope, token hash stored
	const agent = await lookupAgentById("ai:svcbot");
	assert.ok(agent, "agent persisted");
	assert.deepEqual(agent.scope, SCOPE);
	assert.notEqual(agent.tokenHash, data.token, "only hash stored");
	assert.equal(
		agent.tokenHash,
		(await import("node:crypto")).createHash("sha256").update(data.token).digest("hex"),
	);
});

test("re-registration with service token rotates the token (replaces agent)", async () => {
	ensureServiceToken();
	const svc = getServiceToken();

	const res1 = await registerPOST(makeReq("ai:svcbot", { "X-Service-Token": svc }));
	const d1 = (await res1.json()) as { token: string };
	const res2 = await registerPOST(makeReq("ai:svcbot", { "X-Service-Token": svc }));
	assert.equal(res2.status, 200);
	const d2 = (await res2.json()) as { token: string; warning?: string };
	assert.notEqual(d1.token, d2.token);
	assert.ok(d2.warning, "rotation warning surfaced");
});

test("invalid service token → 202 pending (legacy TOFU), no agent stored", async () => {
	ensureServiceToken();
	const res = await registerPOST(
		makeReq("ai:svcnobody", { "X-Service-Token": "wv_svc_wrong" }),
	);
	assert.equal(res.status, 202);
	const data = (await res.json()) as { status: string; registrationId: string };
	assert.equal(data.status, "pending");
	assert.ok(data.registrationId);
	assert.equal(await lookupAgentById("ai:svcnobody"), null);
});

test("missing service token header → 202 pending (legacy TOFU)", async () => {
	const res = await registerPOST(makeReq("ai:svcnobody2", {}));
	assert.equal(res.status, 202);
	const data = (await res.json()) as { status: string };
	assert.equal(data.status, "pending");
});

test("ensureServiceToken is idempotent and persists to ~/.wiki-viewer/service-token", async () => {
	const t1 = ensureServiceToken();
	const t2 = ensureServiceToken();
	assert.equal(t1, t2);
	assert.ok(t1.startsWith("wv_svc_"));
	assert.equal(t2, getServiceToken());
});
