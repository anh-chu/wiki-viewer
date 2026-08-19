import { readFile } from "node:fs/promises";
import path from "node:path";
import { containedWrite, hashContent } from "@/lib/fs/contained-write";
import { carbonizeLiveVariant } from "./carbonize";
import { LiveEngineClient, createLiveEngineClient, type LivePollEvent } from "@/lib/live-engine/client";
import { type LiveEngineInfo, stopEngine } from "@/lib/live-engine/supervisor";
import type { LiveEngineKey } from "@/lib/live-engine/paths";
import {
	closeScaffold,
	createScaffold,
	getEngineEventMapping,
	getLatestScaffold,
	getScaffold,
	mapEngineEvent,
	saveEngineReply,
	updateScaffold,
	type LiveWebScaffold,
} from "./scaffold-store";
import {
	getOrCreateSession,
	enqueueRequest,
	getRequest,
	latestRequest,
	type LiveRequest,
} from "./store";
import { createVariantsPreview, getPreview, linkRequest } from "@/lib/web-tweak/preview-store";

export interface LiveBridgeStartInput {
	engine: LiveEngineInfo;
	rootDir: string;
	client?: LiveEngineClient;
}

export type LiveBridgeState = "running" | "stopped" | "error";

export interface LiveBridgeStatus {
	key: LiveEngineKey;
	state: LiveBridgeState;
	generation: number;
	activeRequestId: string | null;
	activeScaffoldId: string | null;
	lastError: string | null;
}

interface BridgeEntry extends LiveBridgeStatus {
	rootDir: string;
	client: LiveEngineClient;
	abort: AbortController;
}

const bridges = new Map<string, BridgeEntry>();
const generations = new Map<string, number>();
const resolvingRequests = new Set<string>();
const resolvingScaffolds = new Set<string>();

function keyOf(key: LiveEngineKey): string {
	return `${key.workspaceId}:${key.relPath}`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) { resolve(); return; }
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

function current(entry: BridgeEntry): boolean {
	return bridges.get(keyOf(entry.key)) === entry && !entry.abort.signal.aborted && generations.get(keyOf(entry.key)) === entry.generation;
}

function eventId(event: LivePollEvent): string | null {
	const value = event.engineEventId ?? event.id;
	return typeof value === "string" && value.length > 0 ? value : null;
}

function eventString(event: LivePollEvent, name: string, fallback = ""): string {
	const value = event[name];
	return typeof value === "string" ? value.slice(0, 4096) : fallback;
}

function elementFacts(event: LivePollEvent): { selector: string; tag: string; snippet: string; text: string } {
	const raw = event.element;
	const element = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	return {
		selector: eventString(event, "selector", eventString(element, "selector", "body")),
		tag: eventString(event, "tag", eventString(element, "tag", "body")),
		snippet: eventString(event, "snippet", eventString(element, "snippet")),
		text: eventString(event, "text", eventString(element, "text")),
	};
}

function outstanding(request: LiveRequest | null): boolean {
	return !!request && (request.state === "pending" || request.state === "delivered" || request.state === "working");
}

function scaffoldFromPreview(preview: ReturnType<typeof getPreview>): string | null {
	if (!preview?.variants) return null;
	for (const variant of preview.variants) {
		if (typeof variant.scaffold === "string") return variant.scaffold;
	}
	return null;
}

async function readOriginal(rootDir: string, relPath: string): Promise<{ source: string; hash: string }> {
	try {
		const source = await readFile(path.join(rootDir, relPath), "utf8");
		return { source, hash: hashContent(source) };
	} catch {
		return { source: "", hash: hashContent("") };
	}
}

async function sendReply(entry: BridgeEntry, engineId: string, reply: Record<string, unknown>): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await entry.client.reply({ ...reply, id: engineId }, entry.abort.signal);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < 2) await delay(100 * 2 ** attempt, entry.abort.signal);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type LiveScaffoldResolution =
	| { ok: true; scaffoldId: string; action: "accept" | "discard"; written?: string[] }
	| { ok: false; code: string; detail?: string };

/** Shared internal resolution path used by the authenticated route and bridge. */
export async function resolveLiveScaffold(input: {
	rootDir: string;
	workspaceId: string;
	relPath: string;
	action: "accept" | "discard";
	chosenVariantId?: string;
	paramValues?: Record<string, string | number>;
}): Promise<LiveScaffoldResolution> {
	const scaffold = getLatestScaffold(input.workspaceId, input.relPath);
	if (!scaffold || (scaffold.state !== "open" && scaffold.state !== "ready")) {
		return { ok: false, code: "SCAFFOLD_NOT_FOUND" };
	}
	if (input.action === "discard") {
		closeScaffold(scaffold.id, "discarded");
		return { ok: true, scaffoldId: scaffold.id, action: "discard" };
	}
	if (!scaffold.scaffold || !scaffold.scaffoldHash || !input.chosenVariantId) {
		return { ok: false, code: "NO_VARIANT" };
	}
	if (resolvingScaffolds.has(scaffold.id)) return { ok: false, code: "RESOLUTION_INFLIGHT" };
	resolvingScaffolds.add(scaffold.id);
	try {
		const paramValues = input.paramValues ?? {};
		const baked = carbonizeLiveVariant({
			source: scaffold.scaffold,
			baseHash: scaffold.scaffoldHash,
			chosenVariantId: input.chosenVariantId,
			paramValues,
		});
		if (!baked.ok) return { ok: false, code: baked.code, detail: baked.detail };
		const written = await containedWrite({
			rootDir: input.rootDir,
			relPath: input.relPath,
			expectedBaseHash: scaffold.diskBaseHash,
			content: baked.source,
		});
		if (!written.ok) return { ok: false, code: written.code, detail: written.detail };
		updateScaffold(scaffold.id, {
			chosenVariantId: input.chosenVariantId,
			paramValues,
			state: "accepted",
		});
		closeScaffold(scaffold.id, "accepted");
		return { ok: true, scaffoldId: scaffold.id, action: "accept", written: written.written };
	} finally {
		resolvingScaffolds.delete(scaffold.id);
	}
}

async function resolveAgentRequest(entry: BridgeEntry, engineId: string, requestId: string, scaffoldId: string, eventType: string): Promise<void> {
	if (resolvingRequests.has(requestId)) return;
	resolvingRequests.add(requestId);
	entry.activeRequestId = requestId;
	entry.activeScaffoldId = scaffoldId;
	try {
		while (current(entry)) {
			const request = getRequest(requestId);
			if (!request || outstanding(request)) {
				await delay(80, entry.abort.signal);
				continue;
			}
			const preview = request.previewId ? getPreview(request.previewId) : null;
			const scaffold = scaffoldFromPreview(preview);
			const storedScaffold = getScaffold(scaffoldId);
			if (request.state !== "resolved" || storedScaffold?.state !== "open" || !scaffold) {
				const failure = { id: engineId, type: "error", sourceEventType: eventType, message: "Attached agent did not return a scaffold" };
				saveEngineReply(engineId, failure);
				try { await sendReply(entry, engineId, failure); } catch { /* bounded retry; durable reply replays */ }
				return;
			}
			if (resolvingScaffolds.has(scaffoldId)) return;
			resolvingScaffolds.add(scaffoldId);
			try {
				const latest = getScaffold(scaffoldId);
				if (!latest || latest.state !== "open") return;
				updateScaffold(scaffoldId, { scaffold, state: "ready" });
			} finally {
				resolvingScaffolds.delete(scaffoldId);
			}
			const reply: Record<string, unknown> = {
				id: engineId,
				type: "done",
				sourceEventType: eventType,
				scaffold,
				variants: preview?.variants ?? null,
			};
			saveEngineReply(engineId, reply);
			try {
				await sendReply(entry, engineId, reply);
			} catch {
				/* The durable reply replays on the next engine event delivery. */
			}
			return;
		}
	} finally {
		resolvingRequests.delete(requestId);
	}
}

async function handleResolutionEvent(entry: BridgeEntry, event: LivePollEvent, type: "accept" | "discard"): Promise<void> {
	const id = eventId(event);
	if (!id) return;
	const replay = getEngineEventMapping(id);
	if (replay?.reply) {
		await sendReply(entry, id, replay.reply);
		return;
	}
	const scaffold = getLatestScaffold(entry.key.workspaceId, entry.key.relPath);
	const mapping = replay ?? mapEngineEvent(id, `engine:${id}`, scaffold?.id ?? `engine:${id}`);
	if (mapping.reply) {
		await sendReply(entry, id, mapping.reply);
		return;
	}
	const paramValues = event.paramValues && typeof event.paramValues === "object" && !Array.isArray(event.paramValues)
		? Object.fromEntries(Object.entries(event.paramValues).filter(([, value]) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) as Record<string, string | number>
		: {};
	const chosenVariantId = typeof event.variantId === "string" ? event.variantId : undefined;
	const result = await resolveLiveScaffold({
		rootDir: entry.rootDir,
		workspaceId: entry.key.workspaceId,
		relPath: entry.key.relPath,
		action: type,
		chosenVariantId,
		paramValues,
	});
	const reply: Record<string, unknown> = result.ok
		? { id, type: "done", action: type, scaffoldId: result.scaffoldId, written: result.written ?? [] }
		: { id, type: "error", action: type, code: result.code, message: result.detail ?? result.code };
	saveEngineReply(id, reply);
	await sendReply(entry, id, reply);
	if (result.ok) {
		stopLiveBridge(entry.key);
		await stopEngine(entry.key);
	}
}

async function handleEvent(entry: BridgeEntry, event: LivePollEvent): Promise<void> {
	const type = eventString(event, "type");
	if (type === "accept" || type === "discard") {
		await handleResolutionEvent(entry, event, type);
		return;
	}
	if (type !== "generate" && type !== "steer") return;
	const id = eventId(event);
	if (!id) return;

	const replay = getEngineEventMapping(id);
	if (replay?.reply) {
		await sendReply(entry, id, replay.reply);
		return;
	}
	if (replay) {
		void resolveAgentRequest(entry, id, replay.liveRequestId, replay.scaffoldId, type);
		return;
	}

	const session = getOrCreateSession(entry.key.workspaceId);
	const latest = latestRequest(session.id);
	if (outstanding(latest)) {
		const busy = { id, type: "busy", sourceEventType: type, retry: true };
		try { await sendReply(entry, id, busy); } catch { /* lease/replay will retry */ }
		return;
	}

	const original = await readOriginal(entry.rootDir, entry.key.relPath);
	const facts = elementFacts(event);
	const scaffold = createScaffold({
		sessionId: session.id,
		workspaceId: entry.key.workspaceId,
		relPath: entry.key.relPath,
		originalSource: original.source,
		diskBaseHash: original.hash,
	});
	const preview = createVariantsPreview({
		sessionId: session.id,
		workspaceId: entry.key.workspaceId,
		path: entry.key.relPath,
		selector: facts.selector,
		tag: facts.tag,
		snippet: facts.snippet,
		text: facts.text,
		note: eventString(event, "freeformPrompt", eventString(event, "action", "Generate live variants")),
	});
	const enqueued = enqueueRequest({
		sessionId: session.id,
		workspaceId: entry.key.workspaceId,
		path: entry.key.relPath,
		kind: "web.tweak.variants",
		instruction: eventString(event, "freeformPrompt", eventString(event, "action", "Generate live variants")),
		previewId: preview.id,
		selectionText: JSON.stringify({ previewId: preview.id, selector: facts.selector, tag: facts.tag, snippet: facts.snippet }),
	});
	if (!enqueued.ok) {
		const busy = { id, type: "busy", sourceEventType: type, retry: true };
		try { await sendReply(entry, id, busy); } catch { /* no-op */ }
		return;
	}
	linkRequest(preview.id, enqueued.request.id);
	entry.activeRequestId = enqueued.request.id;
	entry.activeScaffoldId = scaffold.id;
	const mapped = mapEngineEvent(id, enqueued.request.id, scaffold.id);
	if (mapped.reply) {
		await sendReply(entry, id, mapped.reply);
		return;
	}
	void resolveAgentRequest(entry, id, enqueued.request.id, scaffold.id, type);
}

async function run(entry: BridgeEntry): Promise<void> {
	let failures = 0;
	while (current(entry)) {
		try {
			const event = await entry.client.poll({ timeoutMs: 1_000, leaseMs: 5_000, types: ["generate", "steer", "accept", "discard"], signal: entry.abort.signal });
			if (entry.abort.signal.aborted) return;
			failures = 0;
			await handleEvent(entry, event);
		} catch (error) {
			if (entry.abort.signal.aborted) return;
			failures++;
			entry.lastError = error instanceof Error ? error.message : String(error);
			if (failures >= 5) {
				entry.state = "error";
				return;
			}
			await delay(Math.min(2_000, 100 * 2 ** (failures - 1)), entry.abort.signal);
		}
	}
}

export function startLiveBridge(input: LiveBridgeStartInput): LiveBridgeStatus {
	const key = keyOf(input.engine);
	const prior = bridges.get(key);
	if (prior) prior.abort.abort();
	const generation = (generations.get(key) ?? 0) + 1;
	generations.set(key, generation);
	const entry: BridgeEntry = {
		key: { workspaceId: input.engine.workspaceId, relPath: input.engine.relPath },
		state: "running",
		generation,
		activeRequestId: null,
		activeScaffoldId: getLatestScaffold(input.engine.workspaceId, input.engine.relPath)?.id ?? null,
		lastError: null,
		rootDir: input.rootDir,
		client: input.client ?? createLiveEngineClient(input.engine),
		abort: new AbortController(),
	};
	bridges.set(key, entry);
	void run(entry);
	return publicStatus(entry);
}

export const startBridge = startLiveBridge;

export function stopLiveBridge(keyInput: LiveEngineKey): void {
	const key = keyOf(keyInput);
	const entry = bridges.get(key);
	if (!entry) return;
	entry.abort.abort();
	entry.state = "stopped";
	bridges.delete(key);
}

export const stopBridge = stopLiveBridge;

function publicStatus(entry: BridgeEntry): LiveBridgeStatus {
	return {
		key: entry.key,
		state: entry.state,
		generation: entry.generation,
		activeRequestId: entry.activeRequestId,
		activeScaffoldId: entry.activeScaffoldId,
		lastError: entry.lastError,
	};
}

export function getLiveBridgeStatus(keyInput: LiveEngineKey): LiveBridgeStatus | null {
	const entry = bridges.get(keyOf(keyInput));
	return entry ? publicStatus(entry) : null;
}

export const getBridgeStatus = getLiveBridgeStatus;

export function _resetForTests(): void {
	for (const entry of bridges.values()) entry.abort.abort();
	bridges.clear();
	resolvingRequests.clear();
	resolvingScaffolds.clear();
}
