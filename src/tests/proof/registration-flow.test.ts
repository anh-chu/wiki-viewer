/**
 * End-to-end TOFU registration flow tests.
 *
 * Tests: POST register → poll (pending) → admin approve → poll (token pickup, one-shot) → 410 consumed
 *        POST register → admin deny → poll 410 denied
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-reg-flow-test-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
});

// Import routes after HOME is set (disk reads are lazy)
import { POST as registerPOST } from "../../app/api/agent/register/route.js";
import { GET as pollGET } from "../../app/api/agent/register/[regId]/route.js";
import { POST as approvePOST } from "../../app/api/agent/admin/registrations/[regId]/approve/route.js";
import { POST as denyPOST } from "../../app/api/agent/admin/registrations/[regId]/deny/route.js";
import { GET as listPendingGET } from "../../app/api/agent/admin/registrations/route.js";
import { ensureRegistry } from "../../lib/proof/registry.js";
import { makeUserSession } from "./helpers/auth-session.js";

async function getOwnerHeaders(): Promise<Record<string, string>> {
	await ensureRegistry();
	const cookies = await makeUserSession();
	return { Cookie: cookies };
}

function makeRegisterReq(body: Record<string, unknown>): Request {
	// Auto-fill required fields unless explicitly overridden
	const payload: Record<string, unknown> = {
		displayName: "Test Agent",
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		...body,
	};
	return new Request("http://localhost:3000/api/agent/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

beforeEach(async () => {
	// Reset rate-limit buckets before each test
	const { _resetRegisterBuckets } = await import("../../lib/proof/register-rate-limit");
	_resetRegisterBuckets();
});

function makePollReq(regId: string): Request {
	return new Request(`http://localhost:3000/api/agent/register/${regId}`);
}

function makeApproveReq(regId: string, extraHeaders: Record<string, string>): Request {
	return new Request(`http://localhost:3000/api/agent/admin/registrations/${regId}/approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...extraHeaders },
		body: "{}",
	});
}

function makeDenyReq(regId: string, extraHeaders: Record<string, string>): Request {
	return new Request(`http://localhost:3000/api/agent/admin/registrations/${regId}/deny`, {
		method: "POST",
		headers: extraHeaders,
	});
}

function makeListReq(extraHeaders: Record<string, string>): Request {
	return new Request("http://localhost:3000/api/agent/admin/registrations", {
		headers: extraHeaders,
	});
}

// ── Register → approve → pickup → replay consumed ─────────────────────────────

test("POST /register returns 202 with registrationId", async () => {
	const res = await registerPOST(makeRegisterReq({ id: "ai:flow-test-a", displayName: "Flow A" }));
	assert.equal(res.status, 202);
	const body = (await res.json()) as { registrationId: string; pollUrl: string; status: string };
	assert.equal(body.status, "pending");
	assert.ok(body.registrationId.startsWith("reg_"));
	assert.ok(body.pollUrl.includes(body.registrationId));
});

test("GET /register/:regId returns 202 status:pending before approval", async () => {
	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-test-b" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };
	const pollRes = await pollGET(makePollReq(registrationId), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(pollRes.status, 202);
	const body = (await pollRes.json()) as { status: string };
	assert.equal(body.status, "pending");
});

test("Full flow: register → list pending → approve → poll pickup → 410 on replay", async () => {
	const ownerH = await getOwnerHeaders();

	// 1. Register
	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-approve" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };

	// 2. List pending — should appear
	const listRes = await listPendingGET(makeListReq(ownerH));
	assert.equal(listRes.status, 200);
	const { pending } = (await listRes.json()) as { pending: Array<{ registrationId: string }> };
	assert.ok(pending.some((r) => r.registrationId === registrationId));

	// 3. Approve
	const approveRes = await approvePOST(makeApproveReq(registrationId, ownerH), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(approveRes.status, 200);
	const approveBody = (await approveRes.json()) as { ok: boolean; agentId: string };
	assert.equal(approveBody.ok, true);
	assert.equal(approveBody.agentId, "ai:flow-approve");

	// 4. Poll — should get token (status: approved)
	const pollRes1 = await pollGET(makePollReq(registrationId), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(pollRes1.status, 200);
	const pollBody1 = (await pollRes1.json()) as { status: string; token: string; agentId: string };
	assert.equal(pollBody1.status, "approved");
	assert.ok(typeof pollBody1.token === "string" && pollBody1.token.length > 0);
	assert.equal(pollBody1.agentId, "ai:flow-approve");

	// 5. Poll again — token consumed, 410
	const pollRes2 = await pollGET(makePollReq(registrationId), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(pollRes2.status, 410);
	const pollBody2 = (await pollRes2.json()) as { status: string };
	assert.equal(pollBody2.status, "consumed");
});

// ── Register → deny → poll 410 ────────────────────────────────────────────────

test("Denied registration: register → deny → poll returns 410 denied", async () => {
	const ownerH = await getOwnerHeaders();

	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-deny" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };

	const denyRes = await denyPOST(makeDenyReq(registrationId, ownerH), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(denyRes.status, 200);

	const pollRes = await pollGET(makePollReq(registrationId), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(pollRes.status, 410);
	const body = (await pollRes.json()) as { status: string };
	assert.equal(body.status, "denied");
});

// ── Validation errors ─────────────────────────────────────────────────────────

test("POST /register with invalid id returns 400", async () => {
	const res = await registerPOST(makeRegisterReq({ id: "invalid-id" }));
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PAYLOAD");
});

test("POST /register with missing id returns 400", async () => {
	const res = await registerPOST(makeRegisterReq({ displayName: "No ID" }));
	assert.equal(res.status, 400);
});

test("GET /register unknown regId returns 404", async () => {
	const res = await pollGET(makePollReq("reg_doesnotexist"), {
		params: Promise.resolve({ regId: "reg_doesnotexist" }),
	});
	assert.equal(res.status, 404);
});

test("POST approve without owner cookie returns 401", async () => {
	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-noauth" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };
	const res = await approvePOST(makeApproveReq(registrationId, {}), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(res.status, 401);
});

test("POST deny without owner cookie returns 401", async () => {
	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-nodenyauth" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };
	const res = await denyPOST(makeDenyReq(registrationId, {}), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(res.status, 401);
});

test("POST approve already-approved registration returns 409", async () => {
	const ownerH = await getOwnerHeaders();

	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-double-approve" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };

	await approvePOST(makeApproveReq(registrationId, ownerH), {
		params: Promise.resolve({ regId: registrationId }),
	});
	const res = await approvePOST(makeApproveReq(registrationId, ownerH), {
		params: Promise.resolve({ regId: registrationId }),
	});
	assert.equal(res.status, 409);
});

// ── Oracle fix #1: registrationId entropy ────────────────────────────────────

test("POST /register: registrationId has 128-bit entropy (reg_<32hex>)", async () => {
	const res = await registerPOST(
		makeRegisterReq({ id: "ai:entropy-test", displayName: "Entropy", scope: { paths: ["**/*"], ops: ["read"] } }),
	);
	assert.equal(res.status, 202);
	const body = (await res.json()) as { registrationId: string };
	assert.match(body.registrationId, /^reg_[0-9a-f]{32}$/);
});

// ── Oracle fix #3: register input validation ──────────────────────────────────

test("POST /register: displayName too long returns 400", async () => {
	const res = await registerPOST(
		makeRegisterReq({
			id: "ai:validation-a",
			displayName: "x".repeat(81),
			scope: { paths: ["**/*"], ops: ["read"] },
		}),
	);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PAYLOAD");
});

test("POST /register: scope.paths empty returns 400", async () => {
	const res = await registerPOST(
		makeRegisterReq({
			id: "ai:validation-b",
			displayName: "Test",
			scope: { paths: [], ops: ["read"] },
		}),
	);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PAYLOAD");
});

test("POST /register: scope.ops invalid value returns 400", async () => {
	const res = await registerPOST(
		makeRegisterReq({
			id: "ai:validation-c",
			displayName: "Test",
			scope: { paths: ["**/*"], ops: ["read", "destroy"] },
		}),
	);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PAYLOAD");
});

test("POST /register: missing scope returns 400", async () => {
	// Build a request that explicitly omits scope (bypass makeRegisterReq defaults)
	const req = new Request("http://localhost:3000/api/agent/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: "ai:validation-d", displayName: "Test" }),
	});
	const res = await registerPOST(req);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PAYLOAD");
});

test("POST /register: 11th rapid attempt returns 429", async () => {
	const { _resetRegisterBuckets } = await import("../../lib/proof/register-rate-limit.js");
	_resetRegisterBuckets();

	const makeReq = (n: number) =>
		makeRegisterReq({
			id: `ai:rate-reg-${n}`,
			displayName: `Rate ${n}`,
			scope: { paths: ["**/*"], ops: ["read"] },
		});

	// Consume all 10 tokens
	for (let i = 0; i < 10; i++) {
		const res = await registerPOST(makeReq(i));
		assert.ok(res.status !== 429, `Attempt ${i} should not be rate-limited`);
	}

	// 11th should be 429
	const res = await registerPOST(makeReq(10));
	assert.equal(res.status, 429);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "RATE_LIMITED");
});

test("POST approve with custom scope stores custom scope", async () => {
	const ownerH = await getOwnerHeaders();

	const regRes = await registerPOST(makeRegisterReq({ id: "ai:flow-scope" }));
	const { registrationId } = (await regRes.json()) as { registrationId: string };

	const customScope = { paths: ["notes/**"], ops: ["read"] };
	const approveRes = await approvePOST(
		new Request(
			`http://localhost:3000/api/agent/admin/registrations/${registrationId}/approve`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...ownerH },
				body: JSON.stringify({ scope: customScope }),
			},
		),
		{ params: Promise.resolve({ regId: registrationId }) },
	);
	assert.equal(approveRes.status, 200);
});
