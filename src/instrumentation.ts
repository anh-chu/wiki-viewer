/**
 * Next.js instrumentation hook — runs once on server startup, Node.js runtime only.
 * Ensures the embed API key file exists before any request is served.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { ensureApiKey } = await import("./lib/auth/api-key");
		ensureApiKey();
	}
}
