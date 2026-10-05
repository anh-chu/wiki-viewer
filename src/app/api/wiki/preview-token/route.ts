export const runtime = "nodejs";

/**
 * Mint the capability token an HTML preview needs for its nested subrequests.
 *
 * The previewed document has a transient origin (sandbox without
 * allow-same-origin), so the browser withholds cookies from the frames and
 * assets it loads. This route runs in the app's own document, where the session
 * cookie *is* present, and converts that session into a short-lived token
 * limited to the previewed file's directory. See src/lib/preview-token.ts.
 */
import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { issuePreviewToken, previewPrefixFor } from "@/lib/preview-token";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const url = new URL(request.url);
	const path = url.searchParams.get("path") ?? "";

	// Validate the requested path against the workspace before scoping a token
	// to it, so a caller cannot mint a token for a directory the containment
	// rules (or DENIED_SEGMENTS) would refuse.
	const resolved = await resolveWorkspacePath(ctx.rootDir, path, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) return NextResponse.json({ error: "invalid path" }, { status: 400 });

	const { token, expiresAt } = issuePreviewToken({
		rootDir: ctx.rootDir,
		prefix: previewPrefixFor(resolved.relPath),
	});

	return NextResponse.json({ token, expiresAt });
}
