export const runtime = "nodejs";

import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { subscribe } from "@/lib/search/watcher-pool";
import { ensureIndexer } from "@/lib/search/indexer";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return new Response(ctx.code, { status: ctx.status });
	const { ws, rootDir } = ctx;

	// Fire-and-forget: brings the indexer up on first SSE connection per workspace.
	ensureIndexer(ws.id, rootDir).catch((e) =>
		console.error("[search] ensureIndexer failed", e),
	);

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
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

			// Subscribe via the shared pool -- no second watcher is created.
			unsubscribe = subscribe(ws.id, rootDir, (type, relPath) => {
				send({ type, path: relPath });
			});

			// Heartbeat keeps the connection alive through proxies / load balancers.
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
			unsubscribe?.();
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
