/**
 * Main-thread client for the markdown worker.
 *
 * Strategy:
 *  - Cache hit  → return synchronously-resolved HTML (no worker round-trip).
 *  - Cache miss → offload the parse to the worker; cache + return the result.
 *  - No worker (SSR, tests, load failure) → fall back to the in-process pipeline.
 *
 * The cache is shared with the sync markdownToHtml() via the exported helpers in
 * to-html.ts, so the editor and the worker never duplicate work.
 */
import {
	markdownToHtml,
	renderCacheKeyFor,
	renderCacheGet,
	renderCacheStore,
	type MarkdownToHtmlOptions,
} from "./to-html";

interface WorkerResponse {
	id: number;
	html?: string;
	error?: string;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (html: string) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker | null {
	if (workerBroken) return null;
	if (worker) return worker;
	if (typeof window === "undefined" || typeof Worker === "undefined") return null;
	try {
		worker = new Worker(new URL("./md-worker.ts", import.meta.url), {
			type: "module",
		});
		worker.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
			const { id, html, error } = e.data;
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (error !== undefined) entry.reject(new Error(error));
			else entry.resolve(html ?? "");
		});
		worker.addEventListener("error", () => {
			// A worker-level failure: tear down and fall back to in-process from now on.
			workerBroken = true;
			for (const { reject } of pending.values()) reject(new Error("md-worker error"));
			pending.clear();
			try { worker?.terminate(); } catch { /* ignore */ }
			worker = null;
		});
		return worker;
	} catch {
		workerBroken = true;
		return null;
	}
}

/**
 * Render markdown to HTML, offloading the parse to a worker on cache miss.
 * Drop-in replacement for markdownToHtml() on the hot editor path.
 */
export async function markdownToHtmlOffThread(
	markdown: string,
	optsOrPagePath?: string | MarkdownToHtmlOptions,
): Promise<string> {
	const opts: MarkdownToHtmlOptions =
		typeof optsOrPagePath === "string"
			? { pagePath: optsOrPagePath }
			: (optsOrPagePath ?? {});

	const key = renderCacheKeyFor(markdown, opts);
	const cached = renderCacheGet(key);
	if (cached !== undefined) return cached;

	const w = getWorker();
	if (!w) {
		// No worker available — in-process pipeline (also populates the cache).
		return markdownToHtml(markdown, opts);
	}

	try {
		const id = nextId++;
		const html = await new Promise<string>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			w.postMessage({ id, markdown, opts });
		});
		renderCacheStore(key, html);
		return html;
	} catch {
		// Worker failed mid-flight — fall back so the open never hangs.
		return markdownToHtml(markdown, opts);
	}
}
