/**
 * Shared types + trusted message reader for the web-tweak picker protocol.
 *
 * The picker script (picker.ts) runs inside a sandboxed null-origin iframe and
 * talks to the parent only via postMessage. Because the iframe shares its
 * execution environment with the untrusted page, EVERY iframe->parent message is
 * hostile input. The parent must:
 *   - verify event.source === iframe.contentWindow (opaque origin makes an
 *     event.origin check insufficient on its own),
 *   - strictly validate the schema and reject unknown/typed-wrong fields,
 *   - treat picker messages as SELECTION FACTS ONLY; they must never trigger a
 *     filesystem write or an accept. Accept/discard are driven by parent control
 *     state keyed on previewId.
 */

/** Data-only DOM preview operation. No HTML/script injection is representable. */
export type DomOp =
	| { type: "setText"; value: string }
	| { type: "setStyle"; prop: string; value: string }
	| { type: "setAttr"; name: string; value: string }
	| { type: "removeAttr"; name: string }
	| { type: "addClass"; value: string }
	| { type: "removeClass"; value: string };

/** Parent -> iframe commands. */
export type PickerCommand =
	| { source: "wv-tweak"; cmd: "enable" }
	| { source: "wv-tweak"; cmd: "disable" }
	| { source: "wv-tweak"; cmd: "remove"; id: string }
	| { source: "wv-tweak"; cmd: "clear" }
	| { source: "wv-tweak"; cmd: "apply"; id: string; ops: DomOp[] }
	| { source: "wv-tweak"; cmd: "revert"; id: string };

/** iframe -> parent events (selection facts + preview lifecycle only). */
export interface PickerRect {
	top: number;
	left: number;
	width: number;
	height: number;
	bottom: number;
	right: number;
}

export type PickerEvent =
	| { source: "wv-tweak"; event: "ready" }
	| {
			source: "wv-tweak";
			event: "selected";
			id: string;
			selector: string;
			elementPath: string;
			tag: string;
			snippet: string;
			text: string;
			rect: PickerRect;
	  }
	| { source: "wv-tweak"; event: "applied"; id: string }
	| { source: "wv-tweak"; event: "reverted"; id: string };

function isRect(v: unknown): v is PickerRect {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	const num = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);
	return (
		num(r.top) &&
		num(r.left) &&
		num(r.width) &&
		num(r.height) &&
		num(r.bottom) &&
		num(r.right)
	);
}

/**
 * Validate + narrow an untrusted MessageEvent into a PickerEvent, but only if it
 * genuinely originates from the given iframe's content window. Returns null for
 * anything that fails identity or schema checks. This is the single trusted
 * entry point the parent UI should use.
 */
export function readPickerMessage(
	e: MessageEvent,
	frame: HTMLIFrameElement | null,
): PickerEvent | null {
	// Identity: the message must come from THIS iframe's window.
	if (!frame || e.source !== frame.contentWindow) return null;
	const d = e.data as Record<string, unknown> | null;
	if (!d || d.source !== "wv-tweak" || typeof d.event !== "string") return null;

	switch (d.event) {
		case "ready":
			return { source: "wv-tweak", event: "ready" };
		case "applied":
		case "reverted":
			return typeof d.id === "string"
				? { source: "wv-tweak", event: d.event, id: d.id }
				: null;
		case "selected": {
			if (
				typeof d.id !== "string" ||
				typeof d.selector !== "string" ||
				typeof d.elementPath !== "string" ||
				typeof d.tag !== "string" ||
				typeof d.snippet !== "string" ||
				typeof d.text !== "string" ||
				!isRect(d.rect)
			) {
				return null;
			}
			// Bound the sizes of untrusted strings we retain/display.
			return {
				source: "wv-tweak",
				event: "selected",
				id: d.id.slice(0, 64),
				selector: d.selector.slice(0, 2000),
				elementPath: d.elementPath.slice(0, 4000),
				tag: d.tag.slice(0, 64),
				snippet: d.snippet.slice(0, 4000),
				text: d.text.slice(0, 2000),
				rect: d.rect,
			};
		}
		default:
			return null;
	}
}

/** Post a typed command to the picker inside an iframe. */
export function postPickerCommand(
	frame: HTMLIFrameElement | null,
	cmd: PickerCommand,
): void {
	frame?.contentWindow?.postMessage(cmd, "*");
}
