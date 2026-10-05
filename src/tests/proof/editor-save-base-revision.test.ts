/**
 * The markdown autosave must always send a numeric baseRevision.
 *
 * ROOT CAUSE this covers: /api/wiki/content refuses a markdown PUT with no
 * baseRevision (400 BASE_REVISION_REQUIRED, asserted in wiki-routes-auth).
 * The content GET only sends X-Wiki-Revision when the file already HAS a
 * sidecar, so the first edit of any sidecar-less .md left `currentRevision`
 * null and savePageToApi omitted the field — the save was refused and the
 * editor showed nothing once the user left edit mode. A missing sidecar is
 * revision 0 server-side, so 0 is the correct base for that case; a real
 * revision must still be forwarded unchanged (stale-write protection).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { useEditorStore } from "../../stores/editor-store.js";

type Recorded = { url: string; method: string; body: unknown };
let recorded: Recorded[] = [];

/** Minimal Response-shaped object; the store only reads status/headers/json. */
function jsonResponse(payload: unknown, revision?: number) {
	const headers = new Headers({ "content-type": "application/json" });
	if (revision !== undefined) headers.set("X-Wiki-Revision", String(revision));
	return { ok: true, status: 200, headers, json: async () => payload };
}

function stubFetch(revision?: number) {
	recorded = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		const method = init?.method ?? "GET";
		if (method === "GET") {
			return jsonResponse({ content: "# hi\n" }, revision) as unknown as Response;
		}
		recorded.push({ url, method, body: JSON.parse(String(init?.body)) });
		return jsonResponse({ ok: true, revision: 1 }, revision) as unknown as Response;
	}) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
const realWindow = (globalThis as unknown as { window?: unknown }).window;

beforeEach(() => {
	// The panel always carries ?root=, and withWs() reads it from window.
	(globalThis as unknown as { window?: unknown }).window = {
		location: { search: "?root=%2Ftmp%2Fws" },
	};
	useEditorStore.getState().clear();
});

afterEach(() => {
	useEditorStore.getState().clear();
	globalThis.fetch = realFetch;
	if (realWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
	else (globalThis as unknown as { window?: unknown }).window = realWindow;
});

test("first save of a sidecar-less markdown file sends baseRevision 0", async () => {
	stubFetch(undefined);
	const store = useEditorStore.getState();
	await store.loadPage("notes/fresh.md");
	assert.equal(useEditorStore.getState().currentRevision, null, "no header => revision unknown");

	useEditorStore.getState().updateContent("# edited\n");
	await useEditorStore.getState().save();

	assert.equal(recorded.length, 1, "exactly one save PUT");
	const saved = recorded[0];
	assert.ok(saved, "one PUT was recorded");
	assert.equal(saved.method, "PUT");
	assert.equal(
		(saved.body as { baseRevision?: unknown }).baseRevision,
		0,
		"a missing baseRevision must become 0, not be omitted",
	);
	assert.equal(useEditorStore.getState().saveStatus, "saved");
});

test("a known revision is still sent unchanged (stale-write protection intact)", async () => {
	stubFetch(7);
	await useEditorStore.getState().loadPage("notes/tracked.md");
	assert.equal(useEditorStore.getState().currentRevision, 7);

	useEditorStore.getState().updateContent("# edited again\n");
	await useEditorStore.getState().save();

	const saved = recorded[0];
	assert.ok(saved, "one PUT was recorded");
	assert.equal((saved.body as { baseRevision?: unknown }).baseRevision, 7);
});
