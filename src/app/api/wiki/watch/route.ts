export const runtime = "nodejs";

import { watch } from "chokidar";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { getRootDir } from "@/lib/root-dir";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const rootDir = getRootDir();
	if (!rootDir) {
		return new Response("Root not configured", { status: 503 });
	}

	const encoder = new TextEncoder();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let watcher: any = null;
	let heartbeatId: ReturnType<typeof setInterval> | null = null;
	let controllerRef: ReadableStreamDefaultController | null = null;

	function send(data: object) {
		if (!controllerRef) return;
		try {
			controllerRef.enqueue(
				encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
			);
		} catch {
			// stream closed
		}
	}

	const stream = new ReadableStream({
		start(controller) {
			controllerRef = controller;

			watcher = watch(rootDir, {
				ignoreInitial: true,
				ignored: /(node_modules|\.git)/,
				persistent: true,
				awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
			});

			function relPath(absPath: string) {
				return path.relative(rootDir, absPath);
			}

			watcher.on("add", (p: string) => send({ type: "add", path: relPath(p) }));
			watcher.on("unlink", (p: string) =>
				send({ type: "unlink", path: relPath(p) }),
			);
			watcher.on("addDir", (p: string) => {
				const rel = relPath(p);
				if (rel) send({ type: "addDir", path: rel }); // skip root itself
			});
			watcher.on("unlinkDir", (p: string) => {
				const rel = relPath(p);
				if (rel) send({ type: "unlinkDir", path: rel });
			});
			watcher.on("change", (p: string) =>
				send({ type: "change", path: relPath(p) }),
			);

			// Heartbeat keeps the connection alive through proxies / load balancers
			heartbeatId = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": heartbeat\n\n"));
				} catch {
					if (heartbeatId !== null) clearInterval(heartbeatId);
				}
			}, 15_000);
		},

		cancel() {
			controllerRef = null;
			if (heartbeatId !== null) clearInterval(heartbeatId);
			watcher?.close();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
