/**
 * Web Worker that runs the markdown→HTML transform off the main thread, so
 * parsing a large uncached document never blocks UI (typing, scrolling,
 * animations). The pipeline is pure string work (no DOM), which is what makes
 * it worker-safe. The render cache lives on the main thread (see
 * markdown-worker-client.ts), so cache hits never reach this worker.
 */
import { renderMarkdownUncached, type MarkdownToHtmlOptions } from "./to-html";

interface RequestMsg {
	id: number;
	markdown: string;
	opts: MarkdownToHtmlOptions;
}

type ResponseMsg =
	| { id: number; html: string }
	| { id: number; error: string };

self.addEventListener("message", (e: MessageEvent<RequestMsg>) => {
	const { id, markdown, opts } = e.data;
	renderMarkdownUncached(markdown, opts)
		.then((html) => {
			const msg: ResponseMsg = { id, html };
			(self as unknown as Worker).postMessage(msg);
		})
		.catch((err: unknown) => {
			const msg: ResponseMsg = {
				id,
				error: err instanceof Error ? err.message : String(err),
			};
			(self as unknown as Worker).postMessage(msg);
		});
});
