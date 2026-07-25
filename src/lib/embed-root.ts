/**
 * Validation for a host-supplied ephemeral root (`?root=`).
 *
 * Deliberately dependency-light (node:path + node:fs only, no better-auth, no
 * workspace registry) so BOTH the Node-runtime middleware and the server-side
 * workspace resolver can share it. One definition of the error codes means a
 * page navigation and an API call can never disagree about whether a root is
 * valid.
 *
 * SECURITY: callers MUST verify API-key auth BEFORE calling this. It stats a
 * caller-supplied path, so running it on unauthenticated requests would turn
 * the response code into a filesystem-existence oracle.
 */
import path from "node:path";
import { statSync } from "node:fs";

/** Machine-readable codes shared with embedding hosts. Keep in sync with docs. */
export type EmbedRootError =
	| "root_requires_api_key"
	| "root_not_found"
	| "root_not_a_directory";

export type EmbedRootResult =
	| { ok: true; rootDir: string }
	| { ok: false; code: EmbedRootError };

/**
 * Resolve and validate a host-supplied root path.
 * Synchronous so middleware (which must return quickly and can't always await
 * cleanly in every branch) and the async resolver can both use it.
 */
export function validateRootParam(rootParam: string): EmbedRootResult {
	const resolved = path.resolve(rootParam);
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(resolved);
	} catch {
		return { ok: false, code: "root_not_found" };
	}
	if (!info.isDirectory()) {
		return { ok: false, code: "root_not_a_directory" };
	}
	return { ok: true, rootDir: resolved };
}
