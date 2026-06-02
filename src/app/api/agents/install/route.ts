export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 50_000_000; // 50 MB

async function readVersion(): Promise<string> {
	try {
		const raw = await readFile(path.resolve(process.cwd(), "package.json"), "utf-8");
		const p = JSON.parse(raw) as { version?: string };
		return p.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function deriveEndpoint(req: NextRequest): string {
	const proto =
		req.headers.get("x-forwarded-proto") ??
		(req.url.startsWith("https") ? "https" : "http");
	const host =
		req.headers.get("x-forwarded-host") ??
		req.headers.get("host") ??
		new URL(req.url).host;
	return `${proto}://${host}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
	const [bootstrapPrompt, version] = await Promise.all([
		readFile(path.resolve(process.cwd(), "agents/bootstrap-prompt.md"), "utf-8").catch(() => ""),
		readVersion(),
	]);

	const endpoint = deriveEndpoint(req);
	const hostHeader = req.headers.get("host") ?? "";
	const hostname = hostHeader.replace(/:[0-9]+$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
	const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	const extraHosts = (process.env.WIKI_OWNER_HOSTS ?? "")
		.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
	const ownerHostTrusted = loopback || extraHosts.includes(hostname);

	return NextResponse.json({
		name: "wiki-viewer",
		version,
		endpoint,
		humanInstructions:
			"Open the wiki-viewer AI Panel (Bot icon in header). Register the agent, then approve it in the Pending Registrations list. The agent receives a one-shot token.",
		ownerBootstrap: {
			hostnameSeen: hostname,
			ownerHostTrusted,
			hint: ownerHostTrusted
				? "This host is trusted for owner cookie issuance. Open the AI Panel in a browser and approve pending registrations."
				: `This host (${hostname}) is not in the owner-trust allowlist, so the AI Panel cannot bootstrap an owner cookie. Restart the server with WIKI_OWNER_HOSTS=${hostname} or access via localhost.`,
		},
		bootstrapPrompt,
		skillTarball: "/api/agents/skill.tar.gz",
		skillRaw: "/api/agents/skill",
		skillCli: "npx skills add anh-chu/wiki-viewer/agents/wiki-viewer-skill",
		routes: [
			// Registration
			{ method: "POST", path: "/api/agent/register", auth: "none", purpose: "Register an agent" },
			{ method: "GET", path: "/api/agent/register/<regId>", auth: "none", purpose: "Poll registration status" },
			// Tier 2 — Collab (markdown block-ops + provenance)
			{ method: "GET", path: "/api/agent/files/<path>.md", auth: "bearer+agent-id", purpose: "Read markdown snapshot (block-ops tier)" },
			{ method: "POST", path: "/api/agent/files/<path>.md", auth: "bearer+agent-id", purpose: "Apply block-ops" },
			{ method: "GET", path: "/api/agent/events/<path>.md", auth: "bearer+agent-id", purpose: "Poll events" },
			{ method: "POST", path: "/api/agent/events/<path>.md", auth: "bearer+agent-id", purpose: "Ack events" },
			// Tier 1 — Raw FS (all file types)
			{ method: "GET",    path: "/api/agent/fs/file/<path>",  auth: "bearer+agent-id", purpose: "Read file bytes. Supports Range. Returns ETag (sha256), X-File-Size, X-File-Mtime, X-Collab-State." },
			{ method: "PUT",    path: "/api/agent/fs/file/<path>",  auth: "bearer+agent-id", purpose: "Atomic whole-file write. If-Match required for overwrites; omit for creates. ?mkdirs=true creates parents. ?force=true bypasses If-Match (audited)." },
			{ method: "DELETE", path: "/api/agent/fs/file/<path>",  auth: "bearer+agent-id", purpose: "Delete file (+ sidecar for .md). Requires If-Match + delete scope op. ?recursive=true for directories." },
			{ method: "GET",    path: "/api/agent/fs/ls/<path>",    auth: "bearer+agent-id", purpose: "Directory listing. ?recursive&limit&depth. Scope-filtered. Excludes .proof/." },
			{ method: "POST",   path: "/api/agent/fs/move",         auth: "bearer+agent-id", purpose: "Move/rename. Body: {from, to, ifMatch?}. Moves .md sidecar too." },
			{ method: "POST",   path: "/api/agent/fs/search",       auth: "bearer+agent-id", purpose: "Server-side grep or glob. Body: {kind:'grep'|'glob', query, path?, glob?, limit?}." },
			// Human presence (for editor lease — drives active collab-state)
			{ method: "POST",   path: "/api/wiki/presence",         auth: "session",          purpose: "Human editor lease heartbeat. Body: {path, action:'open'|'heartbeat'|'close'}." },
		],
		capabilities: {
			maxFileBytes: MAX_FILE_BYTES,
			supportsRange: true,
			ifMatchRequired: true,
			forceBypass: true,
			search: ["grep", "glob"],
			globDialect: "**,*,?",
			scopeOps: ["read", "mutate", "delete"],
			collabStates: ["active", "tracked", "untracked", "not-markdown"],
			collabPrecondition: "If-Collab-Match",
		},
		modes: {
			rule: "Before editing a .md file, read it and check the X-Collab-State response header. If 'active', use block-ops (Tier 2) at the X-Collab-Snapshot URL so a human can review your changes. If 'tracked', prefer block-ops for semantic/prose edits; use raw fs only for mechanical/whole-file ops (reformat, regenerate). If 'untracked', raw fs is fine (a Tier-2 edit would create a sidecar). For non-markdown files, always use raw fs (Tier 2 does not apply). A raw PUT to an active .md is rejected 409 COLLAB_ACTIVE with the Tier-2 URL — switch to block-ops.",
			collabStateHeaders: [
				"X-Collab-State: active|tracked|untracked|not-markdown",
				"X-Collab-Revision: <n>",
				"X-Collab-Snapshot: /api/agent/files/<path>.md",
			],
			tiers: {
				tier1: "Raw FS — /api/agent/fs/* — all file types, fast, light audit (ETag/sha256, file.rawWritten event, audit table). No proof-spans.",
				tier2: "Collab — /api/agent/files/*.md — markdown only, reviewable proof-spans, comments, suggestions. Human can accept/revert.",
			},
		},
		mcpAdapter: {
			package: "wiki-viewer-mcp",
			invoke: "npx wiki-viewer-mcp",
			env: ["WIKI_VIEWER_URL", "WIKI_VIEWER_TOKEN", "WIKI_VIEWER_AGENT_ID"],
			description: "Thin MCP adapter mapping standard MCP filesystem tools onto these endpoints. Reads X-Collab-State and blocks or warns on raw writes to active .md files.",
		},
		ops: [
			"block.replace",
			"block.insertAfter",
			"block.insertBefore",
			"block.delete",
			"block.append",
			"block.prepend",
			"comment.add",
			"comment.reply",
			"comment.resolve",
			"comment.reopen",
			"suggestion.add",
			"suggestion.accept",
			"suggestion.reject",
		],
	});
}
