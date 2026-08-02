/**
 * Shared helper: create a signed-in test user with a known userId.
 *
 * Callers must set process.env.HOME to an isolated tmpdir before importing
 * auth/server; this is handled by src/tests/proof/preload.ts.
 */
import { auth, authReady } from "../../../lib/auth/server.js";

export interface TestUser {
	userId: string;
	email: string;
	cookies: string;
	isAdmin: boolean;
}

function parseCookies(setCookie: string): string {
	return setCookie
		.split(/,(?=[^ ])/)
		.map((c) => c.split(";")[0].trim())
		.join("; ");
}

export async function makeTestUser(opts?: { admin?: boolean }): Promise<TestUser> {
	await authReady();
	const email = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.local`;
	const password = "test1234!";

	const signup = await auth.api.signUpEmail({
		body: { email, password, name: "Test User" },
		asResponse: false,
	});
	if (!signup?.user) {
		throw new Error("signUpEmail did not return a user");
	}

	if (opts?.admin) {
		process.env.WIKI_ADMIN_EMAILS = email;
	}

	const res = await auth.api.signInEmail({
		body: { email, password },
		asResponse: true,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`signInEmail failed: ${res.status} ${text}`);
	}

	const cookies = parseCookies(res.headers.get("set-cookie") ?? "");
	return { userId: signup.user.id, email, cookies, isAdmin: opts?.admin ?? false };
}
