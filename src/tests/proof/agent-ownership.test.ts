/**
 * Per-user agent ownership tests.
 *
 * User A approves an agent → only user A sees it / can revoke it.
 * User B cannot see or revoke user A's agents.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "agent-ownership-test-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
});

import { POST as registerPOST } from "../../app/api/agent/register/route.js";
import { POST as approvePOST } from "../../app/api/agent/admin/registrations/[regId]/approve/route.js";
import { GET as listAgentsGET } from "../../app/api/agent/admin/agents/route.js";
import { POST as revokeAgentPOST } from "../../app/api/agent/admin/agents/[agentId]/revoke/route.js";
import { ensureRegistry } from "../../lib/proof/registry.js";

beforeEach(async () => {
	const { _resetRegisterBuckets } = await import("../../lib/proof/register-rate-limit");
	_resetRegisterBuckets();
});

async function makeUserCookie(tag: string): Promise<string> {
	await ensureRegistry();
	const { auth, authReady } = await import("../../lib/auth/server.js");
	await authReady();
	const res = await auth.api.signUpEmail({
		body: {
			email: `${tag}${Date.now()}@test.local`,
			password: "test1234!",
			name: tag,
		},
		asResponse: true,
	});
	if (!res.ok) throw new Error("signUpEmail failed: " + res.status);
	const setCookie = res.headers.get("set-cookie") ?? "";
	return setCookie
		.split(/,(?=[^ ])/)
		.map((c) => c.split(";")[0].trim())
		.join("; ");
}

async function registerAgent(agentId: string): Promise<string> {
	const req = new Request("http://localhost:3000/api/agent/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: agentId,
			displayName: `Agent ${agentId}`,
			scope: { paths: ["**/*"], ops: ["read"] },
		}),
	});
	const res = await registerPOST(req);
	const data = (await res.json()) as { registrationId: string };
	return data.registrationId;
}

async function approveAgent(regId: string, cookie: string): Promise<void> {
	const req = new Request(
		`http://localhost:3000/api/agent/admin/registrations/${regId}/approve`,
		{ method: "POST", headers: { Cookie: cookie } },
	);
	const res = await approvePOST(req, { params: Promise.resolve({ regId }) });
	assert.equal(res.status, 200, `approve failed: ${await res.text()}`);
}

test("User A approves agent → appears in user A's agent list", async () => {
	const cookieA = await makeUserCookie("usera");
	const regId = await registerAgent("ai:agent-a1");
	await approveAgent(regId, cookieA);

	const listReq = new Request("http://localhost:3000/api/agent/admin/agents", {
		headers: { Cookie: cookieA },
	});
	const res = await listAgentsGET(listReq);
	assert.equal(res.status, 200);
	const data = (await res.json()) as { agents: Array<{ id: string }> };
	assert.ok(data.agents.some((a) => a.id === "ai:agent-a1"));
});

test("User B cannot see user A's agent", async () => {
	const cookieA = await makeUserCookie("usera2");
	const cookieB = await makeUserCookie("userb2");

	const regId = await registerAgent("ai:agent-a2");
	await approveAgent(regId, cookieA);

	const listReq = new Request("http://localhost:3000/api/agent/admin/agents", {
		headers: { Cookie: cookieB },
	});
	const res = await listAgentsGET(listReq);
	assert.equal(res.status, 200);
	const data = (await res.json()) as { agents: Array<{ id: string }> };
	assert.ok(!data.agents.some((a) => a.id === "ai:agent-a2"), "User B should not see user A's agent");
});

test("User B cannot revoke user A's agent → 403", async () => {
	const cookieA = await makeUserCookie("usera3");
	const cookieB = await makeUserCookie("userb3");

	const regId = await registerAgent("ai:agent-a3");
	await approveAgent(regId, cookieA);

	const revokeReq = new Request(
		"http://localhost:3000/api/agent/admin/agents/ai:agent-a3/revoke",
		{ method: "POST", headers: { Cookie: cookieB } },
	);
	const res = await revokeAgentPOST(revokeReq, {
		params: Promise.resolve({ agentId: "ai:agent-a3" }),
	});
	assert.equal(res.status, 403);
});

test("User A can revoke their own agent", async () => {
	const cookieA = await makeUserCookie("usera4");

	const regId = await registerAgent("ai:agent-a4");
	await approveAgent(regId, cookieA);

	const revokeReq = new Request(
		"http://localhost:3000/api/agent/admin/agents/ai:agent-a4/revoke",
		{ method: "POST", headers: { Cookie: cookieA } },
	);
	const res = await revokeAgentPOST(revokeReq, {
		params: Promise.resolve({ agentId: "ai:agent-a4" }),
	});
	assert.equal(res.status, 200);
});
