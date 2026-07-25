/**
 * Client-side scope propagation for host-supplied ephemeral roots.
 *
 * withWs() must carry `root=` (not `ws=`) on every workspace-scoped fetch when
 * an embedding host supplied one, and toRootRelative() must convert the
 * absolute host paths that arrive via ?file= / ?path= / postMessage into the
 * root-relative form every API route expects.
 */
import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
	toRootRelative,
	withWs,
	getEphemeralRoot,
	getActiveWorkspaceId,
} from "../../lib/workspace-client.js";

/** These helpers read window.location.search; fake just enough of it. */
function setSearch(search: string) {
	(globalThis as unknown as { window?: unknown }).window = {
		location: { search },
	};
}

beforeEach(() => {
	delete (globalThis as unknown as { window?: unknown }).window;
});

describe("toRootRelative", () => {
	const ROOT = "/home/sil/guppi";

	test("absolute path inside root -> root-relative", () => {
		assert.equal(toRootRelative("/home/sil/guppi/main.go", ROOT), "main.go");
		assert.equal(
			toRootRelative("/home/sil/guppi/pkg/server/server.go", ROOT),
			"pkg/server/server.go",
		);
	});

	test("already-relative path passes through untouched", () => {
		// Internal tree paths never carry a leading slash, so they must not be
		// mangled by the relativizer.
		assert.equal(toRootRelative("main.go", ROOT), "main.go");
		assert.equal(toRootRelative("pkg/server/server.go", ROOT), "pkg/server/server.go");
		// ...and works even with no root known.
		assert.equal(toRootRelative("main.go", null), "main.go");
	});

	test("the root itself -> empty string (not a file)", () => {
		assert.equal(toRootRelative(ROOT, ROOT), "");
		assert.equal(toRootRelative(ROOT + "/", ROOT), "");
	});

	test("absolute path OUTSIDE root -> null (rejected)", () => {
		assert.equal(toRootRelative("/etc/passwd", ROOT), null);
		assert.equal(toRootRelative("/home/sil/other/main.go", ROOT), null);
	});

	test("sibling dir sharing a name prefix is NOT treated as inside", () => {
		// "/home/sil/guppi-secrets" must not match root "/home/sil/guppi".
		assert.equal(toRootRelative("/home/sil/guppi-secrets/k.txt", ROOT), null);
	});

	test("trailing slash on root is tolerated", () => {
		assert.equal(toRootRelative("/home/sil/guppi/main.go", "/home/sil/guppi/"), "main.go");
	});

	test("absolute path with no known root -> null", () => {
		assert.equal(toRootRelative("/home/sil/guppi/main.go", null), null);
	});
});

describe("withWs scope propagation", () => {
	test("injects root= when a host root is present", () => {
		setSearch("?embed=1&root=%2Fhome%2Fsil%2Fguppi");
		assert.equal(getEphemeralRoot(), "/home/sil/guppi");
		assert.equal(
			withWs("/api/wiki/content?path=main.go"),
			"/api/wiki/content?path=main.go&root=%2Fhome%2Fsil%2Fguppi",
		);
	});

	test("root wins over ws when both are in the URL", () => {
		// The server prefers root; sending only root keeps one source of truth.
		setSearch("?embed=1&ws=ws_abc&root=%2Ftmp%2Fr");
		const out = withWs("/api/wiki");
		assert.match(out, /root=%2Ftmp%2Fr/);
		assert.equal(out.includes("ws="), false, "must not also send ws=");
	});

	test("falls back to ws= when no root is present", () => {
		setSearch("?ws=ws_abc");
		assert.equal(getActiveWorkspaceId(), "ws_abc");
		assert.equal(withWs("/api/wiki"), "/api/wiki?ws=ws_abc");
	});

	test("no root and no ws -> URL untouched", () => {
		setSearch("");
		assert.equal(withWs("/api/wiki"), "/api/wiki");
	});

	test("does not double-inject when root= is already present", () => {
		setSearch("?root=%2Ftmp%2Fr");
		assert.equal(
			withWs("/api/wiki?root=%2Falready%2Fset"),
			"/api/wiki?root=%2Falready%2Fset",
		);
	});

	test("leaves non-workspace-scoped URLs alone", () => {
		setSearch("?root=%2Ftmp%2Fr");
		assert.equal(withWs("/api/agents"), "/api/agents");
		assert.equal(withWs("/api/agent/register"), "/api/agent/register");
	});

	test("scopes the workspace-scoped prefixes the embed panel actually uses", () => {
		setSearch("?root=%2Ftmp%2Fr");
		for (const u of ["/api/wiki", "/api/assets/x.png", "/api/upload/f", "/api/system/reveal"]) {
			assert.match(withWs(u), /root=%2Ftmp%2Fr/, `${u} must be root-scoped`);
		}
	});
});
