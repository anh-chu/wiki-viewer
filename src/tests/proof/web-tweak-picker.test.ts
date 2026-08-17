import assert from "node:assert/strict";
import { test } from "node:test";
import {
	WEB_TWEAK_PICKER_JS,
	injectPicker,
	pickerScriptTag,
} from "../../lib/web-tweak/picker.js";
import { readPickerMessage } from "../../lib/web-tweak/protocol.js";

test("picker script is self-contained and postMessage-only (no same-origin needs)", () => {
	// Guards against reintroducing same-origin coupling: the picker must only
	// talk to the parent via postMessage so it works in a sandboxed null-origin
	// iframe (no allow-same-origin).
	assert.match(WEB_TWEAK_PICKER_JS, /parent\.postMessage/);
	assert.doesNotMatch(WEB_TWEAK_PICKER_JS, /parent\.document|top\.location|document\.cookie/);
	// Idempotent install guard.
	assert.match(WEB_TWEAK_PICKER_JS, /window\.__wvTweakPicker/);
	assert.match(WEB_TWEAK_PICKER_JS, /elementPath: elementPath\(el\)/);
});

test("pickerScriptTag escapes closing script tags", () => {
	const tag = pickerScriptTag();
	assert.ok(tag.startsWith("<script data-wv-tweak>"));
	assert.ok(tag.endsWith("</script>"));
	// The body must not contain a raw </script> that would prematurely close it.
	const body = tag.slice("<script data-wv-tweak>".length, -"</script>".length);
	assert.doesNotMatch(body, /<\/script>/i);
});

test("injectPicker inserts before </body> when present", () => {
	const out = injectPicker("<html><body><h1>Hi</h1></body></html>");
	assert.match(out, /<h1>Hi<\/h1><script data-wv-tweak>[\s\S]*<\/script><\/body>/);
	// exactly one injection
	assert.equal(out.match(/data-wv-tweak/g)?.length, 1);
});

test("injectPicker appends when no </body>", () => {
	const out = injectPicker("<div>fragment</div>");
	assert.ok(out.startsWith("<div>fragment</div>"));
	assert.match(out, /data-wv-tweak/);
});

test("picker script exposes apply/revert with data-only ops and denylist", () => {
	// apply/revert wired into the message handler
	assert.match(WEB_TWEAK_PICKER_JS, /d\.cmd === 'apply'/);
	assert.match(WEB_TWEAK_PICKER_JS, /d\.cmd === 'revert'/);
	// data-only: never sets innerHTML/outerHTML from a message
	assert.doesNotMatch(WEB_TWEAK_PICKER_JS, /\.innerHTML\s*=/);
	assert.doesNotMatch(WEB_TWEAK_PICKER_JS, /\.outerHTML\s*=/);
	// attribute + style ALLOWLISTS present (inert-only), plus text tag denylist
	assert.match(WEB_TWEAK_PICKER_JS, /ATTR_ALLOW/);
	assert.match(WEB_TWEAK_PICKER_JS, /STYLE_ALLOW/);
	assert.match(WEB_TWEAK_PICKER_JS, /TEXT_DENY_TAG/);
	// no URL/nav-bearing attributes in the allowlist
	assert.doesNotMatch(WEB_TWEAK_PICKER_JS, /ATTR_ALLOW[\s\S]{0,400}'(src|href|data|srcset|action|formaction)'/);
	// applied/reverted acknowledgements are posted back
	assert.match(WEB_TWEAK_PICKER_JS, /event: 'applied'/);
	assert.match(WEB_TWEAK_PICKER_JS, /event: 'reverted'/);
});

test("picker script drops badge + mark on remove/clear commands", () => {
	// The adapter cancels a single pick via {cmd:'remove', id} and clears the
	// queue via {cmd:'clear'}; both must tear down the numbered badge (and the
	// dashed mark) so no stale badge survives cancellation.
	assert.match(WEB_TWEAK_PICKER_JS, /d\.cmd === 'remove'/);
	assert.match(WEB_TWEAK_PICKER_JS, /d\.cmd === 'clear'/);
	assert.match(WEB_TWEAK_PICKER_JS, /\.mark\.remove\(\)/);
	assert.match(WEB_TWEAK_PICKER_JS, /\.badge\.remove\(\)/);
});

function frameStub(win: unknown): HTMLIFrameElement {
	return { contentWindow: win } as unknown as HTMLIFrameElement;
}

test("readPickerMessage rejects messages from the wrong source window", () => {
	const win = {};
	const frame = frameStub(win);
	const good = {
		source: win,
		data: { source: "wv-tweak", event: "ready" },
	} as unknown as MessageEvent;
	const wrong = {
		source: {},
		data: { source: "wv-tweak", event: "ready" },
	} as unknown as MessageEvent;
	assert.deepEqual(readPickerMessage(good, frame), { source: "wv-tweak", event: "ready" });
	assert.equal(readPickerMessage(wrong, frame), null);
	assert.equal(readPickerMessage(good, null), null);
});

test("readPickerMessage validates + bounds a selected event", () => {
	const win = {};
	const frame = frameStub(win);
	const ev = {
		source: win,
		data: {
			source: "wv-tweak",
			event: "selected",
			id: "p1",
			selector: "div.card",
			elementPath: "html[1]/body[2]/main[1]/div[3]",
			tag: "div",
			snippet: "<div>x</div>",
			text: "x".repeat(5000),
			rect: { top: 1, left: 2, width: 3, height: 4, bottom: 5, right: 6 },
		},
	} as unknown as MessageEvent;
	const out = readPickerMessage(ev, frame);
	assert.ok(out && out.event === "selected");
	if (out && out.event === "selected") {
		assert.equal(out.selector, "div.card");
		assert.equal(out.elementPath, "html[1]/body[2]/main[1]/div[3]");
		assert.equal(out.text.length, 2000); // bounded
	}
	// missing rect -> rejected
	const bad = {
		source: win,
		data: { source: "wv-tweak", event: "selected", id: "p1", selector: "d", tag: "d", snippet: "", text: "" },
	} as unknown as MessageEvent;
	assert.equal(readPickerMessage(bad, frame), null);
	const withoutElementPath = {
		source: win,
		data: {
			source: "wv-tweak",
			event: "selected",
			id: "p1",
			selector: "d",
			tag: "d",
			snippet: "",
			text: "",
			rect: { top: 1, left: 2, width: 3, height: 4, bottom: 5, right: 6 },
		},
	} as unknown as MessageEvent;
	assert.equal(readPickerMessage(withoutElementPath, frame), null);
});

test("readPickerMessage cannot yield a write/accept command shape", () => {
	// The event union has no field that could carry a source-write instruction;
	// an attacker sending {event:'accept'} is simply dropped.
	const win = {};
	const frame = frameStub(win);
	const attack = {
		source: win,
		data: { source: "wv-tweak", event: "accept", path: "/etc/passwd" },
	} as unknown as MessageEvent;
	assert.equal(readPickerMessage(attack, frame), null);
});
