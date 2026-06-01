/**
 * Shared helper: create a signed-in user session for use in route handler tests.
 * Callers must set process.env.HOME to an isolated tmpdir before importing auth/server.
 */

export async function makeUserSession(): Promise<string> {
	const { auth, authReady } = await import("../../../lib/auth/server.js");
	await authReady();
	const res = await auth.api.signUpEmail({
		body: {
			email: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.local`,
			password: "test1234!",
			name: "Test User",
		},
		asResponse: true,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error("signUpEmail failed: " + res.status + " " + text);
	}
	const setCookie = res.headers.get("set-cookie") ?? "";
	const cookies = setCookie
		.split(/,(?=[^ ])/)
		.map((c) => c.split(";")[0].trim())
		.join("; ");
	return cookies;
}
