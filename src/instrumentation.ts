/**
 * Next.js instrumentation hook — runs once on server startup, Node.js runtime only.
 * Ensures the embed API key file exists before any request is served.
 * Also runs one-off search index maintenance (prune stale workspaces, reclaim pages).
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { ensureApiKey } = await import("./lib/auth/api-key");
		ensureApiKey();

		// Run startup maintenance after the API key is ensured (non-fatal).
		const { runStartupMaintenance } = await import("./lib/search/maintenance");
		void runStartupMaintenance();
	}
}
