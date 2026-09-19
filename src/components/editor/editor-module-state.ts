/**
 * Module-scope editor state: the bounded map and the source-draft revision rule.
 *
 * These live outside `editor.tsx` so they can be tested. The component's module-scope
 * maps existed precisely to survive an editor remount, which made them unreachable from a
 * unit test — and so neither the map's growth nor the draft's staleness had any check.
 * Extracting the two decisions costs nothing at runtime and puts both under test.
 */

/**
 * Bound on how many documents the editor's module maps retain.
 *
 * The maps must outlive the component (an external file change remounts the editor), but
 * "one entry per visited document" is unbounded over a long session, and nothing evicted
 * an entry for a document the reader never returned to. A cap keeps the window that
 * matters — the handful of documents recently open — and drops the rest.
 *
 * ponytail: FIFO by insertion, not LRU. A document revisited without being rewritten can
 * be evicted while still in use, which only costs the state these maps were built to
 * preserve. Re-inserting on read would make it LRU if that ever matters.
 */
export const MODULE_MAP_LIMIT = 20;

/** A source-mode draft, tagged with the revision it was typed against. */
export interface SourceDraft {
	text: string;
	/** Sidecar revision the document was at when this draft was typed. */
	revision: number;
}

/** Record a value, evicting the oldest document once the cap is exceeded. */
export function remember<V>(map: Map<string, V>, key: string, value: V): void {
	// Re-insert so a re-set key moves to the young end rather than keeping its old slot.
	map.delete(key);
	map.set(key, value);
	while (map.size > MODULE_MAP_LIMIT) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

/**
 * Whether a stored draft may be put back into the editor.
 *
 * Only when it was typed against the revision the document is still at. A draft is
 * unsaved text, so restoring it over a document that changed elsewhere silently reverts
 * those changes and gives the reader no sign that the buffer is older than the file.
 * An absent or empty draft is nothing to restore, and an empty string would blank the
 * view rather than seed it.
 */
export function shouldRestoreDraft(
	draft: SourceDraft | null | undefined,
	currentRevision: number,
): boolean {
	if (!draft || !draft.text) return false;
	return draft.revision === currentRevision;
}