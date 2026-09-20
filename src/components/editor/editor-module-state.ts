/**
 * Module-scope editor state: the bounded map and the source-draft revision rule.
 *
 * The editor's maps live at module scope to survive a remount, which also made them
 * unreachable from a unit test — so neither the map's growth nor the draft's staleness
 * had any check. These two decisions are extracted to be testable.
 */

/**
 * Bound on how many documents the editor's module maps retain.
 *
 * The maps outlive the component, so "one entry per visited document" would grow without
 * limit over a long session and nothing evicted a document the reader never returned to.
 *
 * ponytail: FIFO by insertion, not LRU. A document revisited without being rewritten can
 * be evicted while still in use, costing only the state these maps exist to preserve.
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
 * Only at the revision the draft was typed against: it is unsaved text, so restoring it
 * over a document that changed elsewhere would silently revert those changes. An empty
 * draft is nothing to restore, and would blank the view rather than seed it.
 */
export function shouldRestoreDraft(
	draft: SourceDraft | null | undefined,
	currentRevision: number,
): boolean {
	if (!draft || !draft.text) return false;
	return draft.revision === currentRevision;
}