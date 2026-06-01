export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
			{ method: "POST", path: "/api/agent/register", auth: "none", purpose: "Register an agent" },
			{ method: "GET", path: "/api/agent/register/<regId>", auth: "none", purpose: "Poll registration status" },
			{ method: "GET", path: "/api/agent/files/<path>.md", auth: "bearer+agent-id", purpose: "Read snapshot" },
			{ method: "POST", path: "/api/agent/files/<path>.md", auth: "bearer+agent-id", purpose: "Apply ops" },
			{ method: "GET", path: "/api/agent/events/<path>.md", auth: "bearer+agent-id", purpose: "Poll events" },
			{ method: "POST", path: "/api/agent/events/<path>.md", auth: "bearer+agent-id", purpose: "Ack events" },
		],
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
