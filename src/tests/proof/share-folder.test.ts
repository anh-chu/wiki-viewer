/**
 * Public folder shares.
 *
 * A folder share publishes one directory and its descendants, and nothing else.
 * These tests cover the listing, nested reads, bytes, the two containment
 * boundaries (share root, hidden names), the password gate on nested paths, and
 * the kind boundary between file and folder shares.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";

import { POST as createSharePOST } from "../../app/api/share/route.js";
import {
	GET as shareContentGET,
	POST as shareContentPOST,
} from "../../app/api/share/[token]/route.js";
import { GET as shareAssetGET } from "../../app/api/share/[token]/asset/route.js";
import {
	createShare,
	getShareByToken,
	_resetSharedDb,
	type SharedDoc,
} from "../../lib/shared-docs/db.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace, makeFile } from "./helpers/workspace.js";

let tmpHome: string;
let user: Awaited<ReturnType<typeof makeTestUser>>;
let ws: Awaited<ReturnType<typeof createTestWorkspace>>;
let dirShare: SharedDoc;
let fileShare: SharedDoc;
let protectedShare: SharedDoc;

const PASSWORD = "folder-password-123";
const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52,
]);

function ctx(token: string) {
	return { params: Promise.resolve({ token }) };
}

function shareUrl(token: string, route = "", query = ""): string {
	return `http://localhost:3000/api/share/${token}${route}${query}`;
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";
	_resetSharedDb();

	user = await makeTestUser({ admin: true });
	ws = await createTestWorkspace({
		name: "folder-share-ws",
		creatorUserId: user.userId,
		allowedUserIds: [user.userId],
	});

	await makeFile(ws.rootDir, "docs/index.md", "# Index\n\n![shot](./images/shot.png)\n");
	await makeFile(ws.rootDir, "docs/guide/intro.md", "# Intro\n");
	await makeFile(ws.rootDir, "docs/guide/deep/data.txt", "deep data\n");
	await makeFile(ws.rootDir, "docs/images/shot.png", PNG_BYTES);
	await makeFile(ws.rootDir, "docs/.env", "SECRET=1\n");
	await makeFile(ws.rootDir, "docs/guide/.hidden.txt", "hidden\n");
	await makeFile(ws.rootDir, "outside.txt", "outside the share\n");
	await makeFile(ws.rootDir, ".hidden-dir/x.txt", "hidden dir\n");

	// A symlink that leaves the share, one that points at a dotfile, and one
	// that stays inside. Only the last may be served.
	await symlink(path.join(ws.rootDir, "outside.txt"), path.join(ws.rootDir, "docs/link-out.txt"));
	await symlink(path.join(ws.rootDir, "docs/.env"), path.join(ws.rootDir, "docs/link-env.txt"));
	await symlink(path.join(ws.rootDir, "docs/guide"), path.join(ws.rootDir, "docs/link-dir"));

	dirShare = createShare({
		workspaceId: ws.workspace.id,
		filePath: "docs",
		kind: "dir",
		createdBy: user.userId,
	});
	fileShare = createShare({
		workspaceId: ws.workspace.id,
		filePath: "docs/index.md",
		createdBy: user.userId,
	});
	protectedShare = createShare({
		workspaceId: ws.workspace.id,
		filePath: "docs",
		kind: "dir",
		password: PASSWORD,
		createdBy: user.userId,
	});
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	_resetSharedDb();
	await rm(tmpHome, { recursive: true, force: true });
	await rm(ws.rootDir, { recursive: true, force: true });
});

// ─── Creation ────────────────────────────────────────────────────────────────

test("POST /api/share creates a folder share and reports kind=dir", async () => {
	const res = await createSharePOST(
		new Request(`http://localhost:3000/api/share?ws=${ws.workspace.id}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: user.cookies,
			},
			body: JSON.stringify({ path: "docs" }),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { kind: string; token: string; url: string };
	assert.equal(body.kind, "dir");
	assert.equal(body.url, `/s/${body.token}`);
});

test("POST /api/share refuses a folder whose own path is hidden", async () => {
	const res = await createSharePOST(
		new Request(`http://localhost:3000/api/share?ws=${ws.workspace.id}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: user.cookies,
			},
			body: JSON.stringify({ path: ".hidden-dir" }),
		}),
	);
	assert.equal(res.status, 400);
});

test("POST /api/share still creates a file share for a file", async () => {
	const res = await createSharePOST(
		new Request(`http://localhost:3000/api/share?ws=${ws.workspace.id}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost:3000",
				Cookie: user.cookies,
			},
			body: JSON.stringify({ path: "docs/index.md" }),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { kind: string };
	assert.equal(body.kind, "file");
});

// ─── Listing ─────────────────────────────────────────────────────────────────

test("GET a folder share returns a listing with directories first", async () => {
	const res = await shareContentGET(
		new Request(shareUrl(dirShare.token)),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		kind: string;
		name: string;
		path: string;
		entries: Array<{ name: string; path: string; isDir: boolean }>;
		truncated: boolean;
	};
	assert.equal(body.kind, "dir");
	assert.equal(body.name, "docs");
	assert.equal(body.path, "");
	assert.equal(body.truncated, false);
	assert.deepEqual(
		body.entries.map((e) => e.name),
		["guide", "images", "link-dir", "index.md"],
		"hidden names and escaping symlinks must be absent, directories first",
	);
	assert.equal(body.entries[0].isDir, true);
	assert.equal(body.entries[3].isDir, false);
});

test("GET a nested folder lists only that folder", async () => {
	const res = await shareContentGET(
		new Request(shareUrl(dirShare.token, "", "?path=guide")),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		name: string;
		path: string;
		entries: Array<{ name: string }>;
	};
	assert.equal(body.path, "guide");
	assert.equal(body.name, "docs", "every listing labels the share root");
	assert.deepEqual(body.entries.map((e) => e.name), ["deep", "intro.md"]);
});

// ─── Nested reads ────────────────────────────────────────────────────────────

test("GET a file inside the share returns its content and a share-relative path", async () => {
	const res = await shareContentGET(
		new Request(shareUrl(dirShare.token, "", "?path=guide/intro.md")),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		kind: string;
		content: string;
		filename: string;
		path: string;
		filePath: string;
	};
	assert.equal(body.kind, "file");
	assert.ok(body.content.includes("# Intro"));
	assert.equal(body.filename, "intro.md");
	assert.equal(body.path, "guide/intro.md");
	assert.equal(body.filePath, "guide/intro.md");
	assert.ok(
		!JSON.stringify(body).includes("docs/"),
		"no path above the share root may appear in a response",
	);
});

test("GET raw bytes of a file inside the share", async () => {
	const res = await shareAssetGET(
		new Request(shareUrl(dirShare.token, "/asset", "?path=images/shot.png")),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/png");
	const bytes = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(bytes, PNG_BYTES);
});

test("GET asset for a folder path is refused", async () => {
	const res = await shareAssetGET(
		new Request(shareUrl(dirShare.token, "/asset")),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 400);
});

// ─── Containment ─────────────────────────────────────────────────────────────

test("paths that leave the share or hide behind a dot are refused", async () => {
	const rejected = [
		"../outside.txt",
		"/etc/passwd",
		".env",
		"guide/.hidden.txt",
		"link-out.txt",
		"link-env.txt",
		"..%2Foutside.txt",
	];

	for (const rel of rejected) {
		const content = await shareContentGET(
			new Request(shareUrl(dirShare.token, "", `?path=${rel}`)),
			ctx(dirShare.token),
		);
		assert.equal(content.status, 400, `content must refuse ${rel}`);
		assert.equal(
			((await content.json()) as { error: string }).error,
			"path_invalid",
			`content must refuse ${rel} as path_invalid`,
		);

		const bytes = await shareAssetGET(
			new Request(shareUrl(dirShare.token, "/asset", `?path=${rel}`)),
			ctx(dirShare.token),
		);
		assert.equal(bytes.status, 400, `bytes must refuse ${rel}`);
	}
});

test("a symlink that stays inside the share is readable", async () => {
	const res = await shareContentGET(
		new Request(shareUrl(dirShare.token, "", "?path=link-dir/intro.md")),
		ctx(dirShare.token),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { content: string };
	assert.ok(body.content.includes("# Intro"));
});

// ─── Kind boundary ───────────────────────────────────────────────────────────

test("a file share refuses ?path= on both routes", async () => {
	const content = await shareContentGET(
		new Request(shareUrl(fileShare.token, "", "?path=index.md")),
		ctx(fileShare.token),
	);
	assert.equal(content.status, 400);

	const bytes = await shareAssetGET(
		new Request(shareUrl(fileShare.token, "/asset", "?path=index.md")),
		ctx(fileShare.token),
	);
	assert.equal(bytes.status, 400);
});

test("a file share without a path still serves its file", async () => {
	const res = await shareContentGET(
		new Request(shareUrl(fileShare.token)),
		ctx(fileShare.token),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { kind: string; content: string; filePath: string };
	assert.equal(body.kind, "file");
	assert.ok(body.content.includes("# Index"));
	assert.equal(body.filePath, "docs/index.md");
});

// ─── Password gate ───────────────────────────────────────────────────────────

test("a protected folder share gates nested paths and unlocks by cookie", async () => {
	const nested = shareUrl(protectedShare.token, "", "?path=guide/intro.md");

	const locked = await shareContentGET(new Request(nested), ctx(protectedShare.token));
	assert.equal(locked.status, 401);
	assert.equal(((await locked.json()) as { protected?: boolean }).protected, true);

	const unlock = await shareContentPOST(
		new Request(shareUrl(protectedShare.token), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: PASSWORD }),
		}),
		ctx(protectedShare.token),
	);
	assert.equal(unlock.status, 200);
	const unlockBody = (await unlock.json()) as { kind: string };
	assert.equal(unlockBody.kind, "dir", "unlock must return the folder listing");

	const cookie = unlock.headers.get("set-cookie") ?? "";
	assert.ok(
		cookie.includes(`Path=/api/share/${protectedShare.token}`),
		"the grant cookie must cover nested routes",
	);

	const allowed = await shareContentGET(
		new Request(nested, { headers: { Cookie: cookie } }),
		ctx(protectedShare.token),
	);
	assert.equal(allowed.status, 200);
	assert.ok(((await allowed.json()) as { content: string }).content.includes("# Intro"));

	const bytes = await shareAssetGET(
		new Request(shareUrl(protectedShare.token, "/asset", "?path=images/shot.png"), {
			headers: { Cookie: cookie },
		}),
		ctx(protectedShare.token),
	);
	assert.equal(bytes.status, 200);
});

// ─── View counting ───────────────────────────────────────────────────────────

test("the view count moves only for a root view", async () => {
	const share = createShare({
		workspaceId: ws.workspace.id,
		filePath: "docs",
		kind: "dir",
		createdBy: user.userId,
	});
	const before = getShareByToken(share.token)!.viewCount;

	await shareContentGET(
		new Request(shareUrl(share.token, "", "?path=guide/intro.md")),
		ctx(share.token),
	);
	await shareAssetGET(
		new Request(shareUrl(share.token, "/asset", "?path=images/shot.png")),
		ctx(share.token),
	);
	assert.equal(getShareByToken(share.token)!.viewCount, before, "nested reads must not count");

	await shareContentGET(new Request(shareUrl(share.token)), ctx(share.token));
	assert.equal(getShareByToken(share.token)!.viewCount, before + 1, "a root view must count");
});
