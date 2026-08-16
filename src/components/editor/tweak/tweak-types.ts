import type { ReactNode } from "react";

/**
 * Shared "Tweak" feature types.
 *
 * Both the markdown surface (Live Instruct) and the HTML surface (web-tweak)
 * gather one-or-more instructions into a queue, then dispatch the whole queue
 * as a single run. The shared hook (use-tweak-session) owns the queue model,
 * dedup, presence gate and the coarse phase; content-kind adapters own every
 * network call, side-effect (iframe ops / markdown render / snapshot reload)
 * and all surface-specific rendering via slot functions.
 */

/** One queued tweak. Deduped by {@link targetKey}. */
export interface TweakItem {
	itemId: string;
	/** Stable key for the tweak target (blockRef for md, pick id/selector for html). */
	targetKey: string;
	/** Short human-readable label for the target (block text / selector). */
	displaySnippet: string;
	instruction: string;
}

/** A generated alternative the user can preview/cycle before accepting. */
export interface TweakVariant {
	variantId: string;
	label: string;
	/** Rendered preview payload (HTML string for md, opaque for html surface). */
	preview: string;
}

/**
 * Coarse lifecycle phase shared across surfaces. It is a superset — the HTML
 * adapter keeps its own richer internal phase object for confirm/variants
 * substates, but both adapters drive these top-level phases through the shared
 * session so the shared chrome (queue bar visibility) stays consistent.
 */
export type TweakPhase =
	| "targeting"
	| "gathering"
	| "dispatching"
	| "waiting"
	| "preview"
	| "resolving"
	| "message";

/** Input to {@link TweakSession.addItem}. Deduped by targetKey. */
export interface AddItemInput {
	targetKey: string;
	displaySnippet: string;
	instruction: string;
	/** Optional stable id (e.g. picker element id). A fresh id is minted otherwise. */
	itemId?: string;
}

/**
 * Shared queue + presence + phase state. Owned by {@link useTweakSession};
 * consumed by adapters and shared chrome.
 */
export interface TweakSession {
	items: TweakItem[];
	/** Add or, if targetKey already queued, UPDATE the existing item's instruction. */
	addItem: (input: AddItemInput) => string;
	removeItem: (itemId: string) => void;
	/** Drop the whole queue (deselect / clear path). */
	clear: () => void;
	phase: TweakPhase;
	setPhase: (phase: TweakPhase) => void;
	/** Presence gate: is a live agent attached. */
	attached: boolean;
	/** Re-check live presence (called on dispatch for presence honesty). */
	refreshPresence: () => Promise<void>;
}

/**
 * A content-kind adapter. Created per-surface (as a hook) capturing that
 * surface's props/refs and the shared {@link TweakSession}. The shared
 * {@link TweakOverlay} and {@link TweakQueueBar} are generic over this shape.
 */
export interface ContentKindAdapter {
	contentKind: "markdown" | "html";
	/** Dispatch button label: "Rewrite" (md) / "Apply" (html). */
	dispatchLabel: string;
	/** Count-bar noun: "tweak". */
	countBarNoun: string;

	/** Queue projection (mirrors session.items). */
	items: TweakItem[];
	removeItem: (itemId: string) => void;
	/** Clear queue / deselect. */
	clear: () => void;

	/** Whether the shared bottom queue bar should render right now. */
	showQueueBar: boolean;
	/** Dispatch the whole queue as one run (md: Rewrite; html: open confirm). */
	onDispatch: () => void;
	dispatchDisabled: boolean;

	/** Targeting / instruction-authoring slot (surface specific). */
	renderTargeting: () => ReactNode;
	/** Run lifecycle slot: waiting / preview / variants / resolve / message. */
	renderRunPanel: () => ReactNode;
	/** Optional queue-bar extras, e.g. HTML "Copy as prompt". */
	renderQueueBarExtras?: () => ReactNode;
}
