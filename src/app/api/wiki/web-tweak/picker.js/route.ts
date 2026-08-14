import { WEB_TWEAK_PICKER_JS } from "@/lib/web-tweak/picker";

export const runtime = "nodejs";

/**
 * GET /api/wiki/web-tweak/picker.js — serves the element-picker script.
 *
 * The script is inert on its own: it only acts on postMessage commands from the
 * trusted parent window and emits selection facts back. Serving it as public
 * static JS is therefore safe and is the simplest option.
 */
export function GET(): Response {
	return new Response(WEB_TWEAK_PICKER_JS, {
		status: 200,
		headers: {
			"content-type": "application/javascript; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	});
}
