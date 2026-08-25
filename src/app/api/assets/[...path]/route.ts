import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { contentTypeForPath } from "@/lib/mime";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

/**
 * Return a request whose URL carries `key=value` in the query string, reusing
 * the original method, headers (auth, cookies, api-key), and body.
 */
function withInjectedParam(req: Request, key: string, value: string): Request {
	const url = new URL(req.url);
	url.searchParams.set(key, value);
	return new Request(url.toString(), req);
}

function fromBase64Url(token: string): string {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(b64, "base64").toString("utf8");
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const segments = (await params).path;

	// Workspace scope may be encoded as a leading path sentinel so that it
	// survives relative navigation inside a previewed HTML page (see
	// assetPreviewUrl in workspace-client.ts). Translate it back into the query
	// param resolveWorkspaceForUser already understands, preserving the ?root=
	// api-key gate and workspace ACL checks.
	let effReq: Request = request;
	let pathSegments = segments;
	if (segments.length >= 2 && segments[0] === "_ws") {
		effReq = withInjectedParam(request, "ws", segments[1]);
		pathSegments = segments.slice(2);
	} else if (segments.length >= 2 && segments[0] === "_root") {
		effReq = withInjectedParam(request, "root", fromBase64Url(segments[1]));
		pathSegments = segments.slice(2);
	}

	const wsx = await resolveWorkspaceForUser(effReq);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const rel = pathSegments.join("/");

	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	try {
		const info = await stat(resolved.absolutePath);
		if (info.isDirectory())
			return NextResponse.json({ error: "Not a file" }, { status: 400 });

		const contentType = contentTypeForPath(resolved.absolutePath);
		const buffer = await readFile(resolved.absolutePath);
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "private, max-age=60",
			},
		});
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}
