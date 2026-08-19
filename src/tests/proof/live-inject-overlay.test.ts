import assert from "node:assert/strict";
import { test } from "node:test";
import { injectOverlay } from "../../lib/proof/live/inject-overlay";

test("injectOverlay writes Impeccable globals and overlay script before </head>", () => {
	const html = "<!doctype html>\n<html><head><title>Demo</title></head><body>Content</body></html>";
	const out = injectOverlay(html, {
		scriptSrc: "/live.js?token=abc",
		globals: {
			__IMPECCABLE_TOKEN__: "abc",
			__IMPECCABLE_PORT__: 8400,
			__IMPECCABLE_APP_ROOT__: "/workspace/demo",
			__IMPECCABLE_COMMAND_PREFIX__: "/",
			__IMPECCABLE_VOCAB__: [{ value: "bolder", label: "Bolder" }],
			__IMPECCABLE_LIVE_UI_SURFACES__: [{ id: "overlay", ids: ["root"] }],
			__IMPECCABLE_LIVE_MOUNT_CONTRACT__: ["root", "transport", "state", "actions"],
		},
	});

	assert.match(out, /<head>[\s\S]*__IMPECCABLE_TOKEN__[\s\S]*<script src="\/live\.js\?token=abc"><\/script>[\s\S]*<\/head>/);
	assert.ok(out.indexOf("__IMPECCABLE_PORT__") > out.indexOf("<title>Demo</title>"));
	assert.equal(out.slice(0, out.indexOf("<head>")), html.slice(0, html.indexOf("<head>")));
	assert.equal(out.slice(out.indexOf("</head>") + "</head>".length), html.slice(html.indexOf("</head>") + "</head>".length));
});

test("injectOverlay uses body and append fallbacks", () => {
	const config = { scriptSrc: "/live.js", globals: { __IMPECCABLE_PORT__: 8400 } };
	const body = "<html><body><main>Demo</main></body></html>";
	const bodyOut = injectOverlay(body, config);
	assert.ok(bodyOut.indexOf("<script") < bodyOut.indexOf("</body>"));
	assert.equal(injectOverlay("<main>fragment</main>", config), "<main>fragment</main>" + injectOverlay("", config));
});

test("injectOverlay is idempotent and preserves surrounding HTML", () => {
	const html = "<html>\r\n<head>\r\n  <meta charset=\"utf-8\">\r\n</head>\r\n<body>Hi</body>\r\n</html>";
	const config = { scriptSrc: "/live.js", globals: { __IMPECCABLE_PORT__: 8400 } };
	const once = injectOverlay(html, config);
	assert.equal(injectOverlay(once, config), once);
	assert.ok(once.startsWith("<html>\r\n<head>\r\n  <meta charset=\"utf-8\">\r\n"));
	assert.ok(once.endsWith("</head>\r\n<body>Hi</body>\r\n</html>"));
	assert.equal((once.match(/impeccable-live-start/g) ?? []).length, 1);
});

test("injectOverlay anchors on the structural </head>, not one inside a script string (F3)", () => {
	const html = '<html><head><title>Demo</title></head><body><script>var t = "</head>";</script></body></html>';
	const out = injectOverlay(html, { scriptSrc: "/live.js", globals: { __IMPECCABLE_PORT__: 8400 } });
	// Injected block sits before the real </head>, i.e. before the body script.
	assert.ok(out.indexOf("impeccable-live-start") < out.indexOf("<body>"));
	assert.ok(out.indexOf("impeccable-live-start") < out.indexOf('var t ='));
	// The script string literal is left untouched.
	assert.ok(out.includes('var t = "</head>";'));
});

test("injectOverlay parameterizes globals and JSON-escapes script values", () => {
	const first = injectOverlay("<head></head>", {
		scriptSrc: "/live.js",
		globals: { __IMPECCABLE_TOKEN__: "</script><script>alert(1)</script>" },
	});
	const second = injectOverlay("<head></head>", {
		scriptSrc: "/other-live.js",
		globals: { __IMPECCABLE_TOKEN__: "different", __IMPECCABLE_PORT__: 9000 },
	});

	assert.match(first, /window\.__IMPECCABLE_TOKEN__\s*=\s*"<\\\/script><script>alert\(1\)<\\\/script>";/);
	assert.doesNotMatch(first, /window\.__IMPECCABLE_TOKEN__\s*=\s*"<\/script>/);
	assert.match(second, /__IMPECCABLE_TOKEN__[\s\S]*different/);
	assert.match(second, /__IMPECCABLE_PORT__[\s\S]*9000/);
	assert.match(second, /<script src="\/other-live\.js"><\/script>/);
	assert.doesNotMatch(second, /8400/);
});
