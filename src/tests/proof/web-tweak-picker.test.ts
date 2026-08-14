import assert from "node:assert/strict";
import { test } from "node:test";
import {
	WEB_TWEAK_PICKER_JS,
	injectPicker,
	pickerScriptTag,
} from "../../lib/web-tweak/picker.js";

test("picker script is self-contained and postMessage-only (no same-origin needs)", () => {
	// Guards against reintroducing same-origin coupling: the picker must only
	// talk to the parent via postMessage so it works in a sandboxed null-origin
	// iframe (no allow-same-origin).
	assert.match(WEB_TWEAK_PICKER_JS, /parent\.postMessage/);
	assert.doesNotMatch(WEB_TWEAK_PICKER_JS, /parent\.document|top\.location|document\.cookie/);
	// Idempotent install guard.
	assert.match(WEB_TWEAK_PICKER_JS, /window\.__wvTweakPicker/);
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
