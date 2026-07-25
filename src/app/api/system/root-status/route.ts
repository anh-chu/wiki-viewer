/**
 * LEGACY — process-global root readout. Do not build new logic on this.
 *
 * `path` reports the legacy process-global `globalThis.__wikiRootDir`
 * (root-dir.ts), set once from ROOT_DIR / the CLI argument. It is NOT the
 * effective root of any given request: real resolution is per-request in
 * workspace-context.ts (?root= → ?ws= → x-workspace → most-recent → this
 * global as a last-resort fallback). On a multi-workspace instance, or any
 * request carrying ?root= / ?ws=, this value is unrelated to what was served.
 *
 * In particular: do NOT compare a file path against this to decide whether a
 * workspace switch is needed — it will be confidently wrong. Ask for the
 * workspace you want explicitly instead (?ws=, or ?root= for API-key-
 * authenticated embedding hosts).
 *
 * Retained only for the single-directory CLI flow (`wiki-viewer <dir>`), where
 * the global and the effective root do coincide.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { getRootDir, isRootDirSet } from "@/lib/root-dir";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	return NextResponse.json({
		configured: isRootDirSet(),
		path: isRootDirSet() ? getRootDir() : null,
	});
}
