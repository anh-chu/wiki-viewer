/**
 * Next.js instrumentation hook — runs once on server startup, Node.js runtime only.
 * Ensures the embed API key file exists before any request is served.
 * Also deletes the obsolete SQLite search index left by earlier versions.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { ensureApiKey } = await import("./lib/auth/api-key");
		ensureApiKey();

		// Remove the obsolete SQLite search index (synchronous, never throws).
		const { deleteLegacySearchDb } = await import("./lib/search/legacy-db-cleanup");
		deleteLegacySearchDb();
	}
}
