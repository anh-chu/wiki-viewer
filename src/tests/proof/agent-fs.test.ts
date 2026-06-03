/**
 * Phase 2 — Tier-1 Raw FS API tests.
 *
 * Covers: GET bytes/ETag/Range, PUT create/overwrite/If-Match, create-collision,
 * .md PUT triggers file.rawWritten+reconcile, DELETE scope+If-Match, ls scope-filter/limits,
 * move+sidecar, search grep/glob+binary-skip+scope, traversal+symlink-escape rejection.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp, rm, writeFile, readFile, mkdir, symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

import { setRootDir } from "../../lib/root-dir.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { writeSidecar, readSidecar, emptySidecar } from "../../lib/proof/sidecar.js";
import { _resetAuditDb } from "../../lib/proof/audit.js";

// Route handlers (loaded after env is set)
let fileGET: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let filePUT: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let filePATCH: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let fileDELETE: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let lsGET: (req: Request, ctx: { params: Promise<{ path?: string[] }> }) => Promise<Response>;
let movePOST: (req: Request) => Promise<Response>;
let searchPOST: (req: Request) => Promise<Response>;

let tmpHome: string;
let tmpRoot: string;

// Tokens
let READ_TOKEN: string;
let MUTATE_TOKEN: string;
let DELETE_TOKEN: string;
let RESTRICTED_TOKEN: string;

function sha256(buf: Buffer): string {
	return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function agentHeaders(token: string, id: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"X-Agent-Id": id,
	};
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "agent-fs-home-"));
	tmpRoot = await mkdtemp(path.join(tmpdir(), "agent-fs-root-"));

	process.env.HOME = tmpHome;
	setRootDir(tmpRoot);
	_resetAuditDb();

	await ensureRegistry();

	READ_TOKEN = randomBytes(32).toString("hex");
	MUTATE_TOKEN = randomBytes(32).toString("hex");
	DELETE_TOKEN = randomBytes(32).toString("hex");
	RESTRICTED_TOKEN = randomBytes(32).toString("hex");

	await addAgent({
		id: "ai:read-agent",
		displayName: "Read Agent",
		tokenHash: hashToken(READ_TOKEN),
		scope: { paths: ["**/*"], ops: ["read"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:mutate-agent",
		displayName: "Mutate Agent",
		tokenHash: hashToken(MUTATE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:delete-agent",
		displayName: "Delete Agent",
		tokenHash: hashToken(DELETE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate", "delete"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:restricted",
		displayName: "Restricted",
		tokenHash: hashToken(RESTRICTED_TOKEN),
		scope: { paths: ["allowed/**"], ops: ["read", "mutate", "delete"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	// Load route handlers after env is set
	const fileRoute = await import("../../app/api/agent/fs/file/[...path]/route.js");
	fileGET = fileRoute.GET;
	filePUT = fileRoute.PUT;
	filePATCH = fileRoute.PATCH;
	fileDELETE = fileRoute.DELETE;

	const lsRoute = await import("../../app/api/agent/fs/ls/[[...path]]/route.js");
	lsGET = lsRoute.GET;

	const moveRoute = await import("../../app/api/agent/fs/move/route.js");
	movePOST = moveRoute.POST;

	const searchRoute = await import("../../app/api/agent/fs/search/route.js");
	searchPOST = searchRoute.POST;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(segments: string[]): { params: Promise<{ path: string[] }> } {
	return { params: Promise.resolve({ path: segments }) };
}

function makeLsCtx(segments?: string[]): { params: Promise<{ path?: string[] }> } {
	return { params: Promise.resolve({ path: segments }) };
}

function fileUrl(rel: string, qs = ""): string {
	return `http://localhost/api/agent/fs/file/${rel}${qs}`;
}

function lsUrl(rel: string, qs = ""): string {
	return `http://localhost/api/agent/fs/ls/${rel}${qs}`;
}

// ── GET tests ────────────────────────────────────────────────────────────────

test("GET: returns raw bytes with ETag, X-File-Size, X-File-Mtime, Content-Type", async () => {
	const content = Buffer.from("hello world");
	await writeFile(path.join(tmpRoot, "hello.txt"), content);

	const req = new Request(fileUrl("hello.txt"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await fileGET(req, makeCtx(["hello.txt"]));
	assert.equal(res.status, 200);

	const body = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(body, content);

	const etag = res.headers.get("etag");
	assert.ok(etag, "ETag header present");
	assert.ok(etag!.includes(createHash("sha256").update(content).digest("hex")), "ETag contains sha256 hex");

	assert.equal(res.headers.get("x-file-size"), String(content.length));
	assert.ok(res.headers.get("x-file-mtime"), "X-File-Mtime present");
	assert.ok(res.headers.get("content-type")?.includes("text/plain"), "Content-Type text/plain for .txt");
});

test("GET: 404 for missing file", async () => {
	const req = new Request(fileUrl("missing.txt"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await fileGET(req, makeCtx(["missing.txt"]));
	assert.equal(res.status, 404);
});

test("GET: supports HTTP Range", async () => {
	const content = Buffer.from("0123456789");
	await writeFile(path.join(tmpRoot, "range.txt"), content);

	const req = new Request(fileUrl("range.txt"), {
		headers: {
			...agentHeaders(READ_TOKEN, "ai:read-agent"),
			Range: "bytes=2-5",
		},
	});
	const res = await fileGET(req, makeCtx(["range.txt"]));
	assert.equal(res.status, 206);

	const slice = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(slice, Buffer.from("2345"));
	assert.ok(res.headers.get("content-range")?.startsWith("bytes 2-5/"), "Content-Range header");
});

test("GET: rejects path traversal", async () => {
	const req = new Request(fileUrl("../etc/passwd"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await fileGET(req, makeCtx(["../etc/passwd"]));
	assert.equal(res.status, 400);
});

test("GET: rejects .proof path", async () => {
	const req = new Request(fileUrl(".proof/something.json"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await fileGET(req, makeCtx([".proof", "something.json"]));
	assert.equal(res.status, 400);
});

test("GET: 401 without auth", async () => {
	const req = new Request(fileUrl("hello.txt"));
	const res = await fileGET(req, makeCtx(["hello.txt"]));
	assert.equal(res.status, 401);
});

test("GET: scope-filtered — restricted agent denied out-of-scope path", async () => {
	await writeFile(path.join(tmpRoot, "secret.txt"), "top secret");

	const req = new Request(fileUrl("secret.txt"), {
		headers: agentHeaders(RESTRICTED_TOKEN, "ai:restricted"),
	});
	const res = await fileGET(req, makeCtx(["secret.txt"]));
	assert.equal(res.status, 403);
});

// ── PUT tests ────────────────────────────────────────────────────────────────

test("PUT: create new file (no If-Match)", async () => {
	const content = Buffer.from("brand new file");
	const req = new Request(fileUrl("new-file.txt"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: content,
	});
	const res = await filePUT(req, makeCtx(["new-file.txt"]));
	assert.equal(res.status, 200);
	const json = await res.json() as { path: string; created: boolean; sha256: string };
	assert.equal(json.path, "new-file.txt");
	assert.equal(json.created, true);

	const written = await readFile(path.join(tmpRoot, "new-file.txt"));
	assert.deepEqual(written, content);
});

test("PUT: overwrite requires If-Match", async () => {
	await writeFile(path.join(tmpRoot, "existing.txt"), "original");

	const req = new Request(fileUrl("existing.txt"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("updated"),
	});
	const res = await filePUT(req, makeCtx(["existing.txt"]));
	assert.equal(res.status, 412);
	const json = await res.json() as { error: string };
	assert.equal(json.error, "PRECONDITION_REQUIRED");
});

test("PUT: create-collision — file exists, no If-Match → 412", async () => {
	await writeFile(path.join(tmpRoot, "collision.txt"), "existing content");
	// Sending PUT without If-Match to an existing file = 412 PRECONDITION_REQUIRED
	const req = new Request(fileUrl("collision.txt"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("new content"),
	});
	const res = await filePUT(req, makeCtx(["collision.txt"]));
	assert.equal(res.status, 412);
});

test("PUT: overwrite with correct If-Match succeeds", async () => {
	const original = Buffer.from("original content");
	await writeFile(path.join(tmpRoot, "ifmatch.txt"), original);
	const sha = sha256(original);

	const req = new Request(fileUrl("ifmatch.txt"), {
		method: "PUT",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"If-Match": `"${sha}"`,
		},
		body: Buffer.from("updated content"),
	});
	const res = await filePUT(req, makeCtx(["ifmatch.txt"]));
	assert.equal(res.status, 200);
	const json = await res.json() as { created: boolean };
	assert.equal(json.created, false);
});

test("PUT: If-Match mismatch → 412 PRECONDITION_FAILED", async () => {
	await writeFile(path.join(tmpRoot, "mismatch.txt"), "content");

	const req = new Request(fileUrl("mismatch.txt"), {
		method: "PUT",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"If-Match": `"sha256:${"0".repeat(64)}"`,
		},
		body: Buffer.from("new"),
	});
	const res = await filePUT(req, makeCtx(["mismatch.txt"]));
	assert.equal(res.status, 412);
	const json = await res.json() as { error: string };
	assert.equal(json.error, "PRECONDITION_FAILED");
});

test("PUT: ?force=true bypasses If-Match for overwrite", async () => {
	await writeFile(path.join(tmpRoot, "force.txt"), "original");

	const req = new Request(fileUrl("force.txt", "?force=true"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("forced update"),
	});
	const res = await filePUT(req, makeCtx(["force.txt"]));
	assert.equal(res.status, 200);
});

test("PUT: ?mkdirs=true creates intermediate directories", async () => {
	const req = new Request(fileUrl("deep/nested/dir/file.txt", "?mkdirs=true"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("deep file"),
	});
	const res = await filePUT(req, makeCtx(["deep", "nested", "dir", "file.txt"]));
	assert.equal(res.status, 200);
	const written = await readFile(path.join(tmpRoot, "deep/nested/dir/file.txt"));
	assert.deepEqual(written, Buffer.from("deep file"));
});

test("PUT: parent dir missing without ?mkdirs → 400", async () => {
	const req = new Request(fileUrl("nonexistent-dir/file.txt"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("content"),
	});
	const res = await filePUT(req, makeCtx(["nonexistent-dir", "file.txt"]));
	assert.equal(res.status, 400);
	const json = await res.json() as { error: string };
	assert.equal(json.error, "PARENT_NOT_FOUND");
});

test("PUT: .md write triggers file.rawWritten event and reconcile", async () => {
	const mdContent = "# Hello\n\nThis is a test.\n";
	const mdPath = "raw-written.md";

	const req = new Request(fileUrl(mdPath), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from(mdContent),
	});
	const res = await filePUT(req, makeCtx([mdPath]));
	assert.equal(res.status, 200);

	// Sidecar should be created with file.rawWritten event
	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar created after .md PUT");
	const rawWrittenEvents = sidecar!.events.filter((e) => e.type === "file.rawWritten");
	assert.ok(rawWrittenEvents.length > 0, "file.rawWritten event in sidecar");
	assert.equal(rawWrittenEvents[0]!.by, "ai:mutate-agent");
	// Fingerprint set correctly
	const fileBuf = await readFile(path.join(tmpRoot, mdPath));
	const expectedSha = sha256(fileBuf);
	assert.equal(sidecar!.fingerprint, expectedSha);
});

test("PUT: .md overwrite updates sidecar fingerprint eagerly (R2 no lazy mismatch)", async () => {
	const mdPath = "eager-reconcile.md";
	const initial = "# Initial\n";
	const updated = "# Updated\n\nNew paragraph.\n";

	// Create with initial content
	await writeFile(path.join(tmpRoot, mdPath), initial);
	const sc = emptySidecar(mdPath);
	sc.fingerprint = sha256(Buffer.from(initial));
	await writeSidecar(tmpRoot, mdPath, sc);

	// PUT updated content with If-Match
	const initialSha = sha256(Buffer.from(initial));
	const req = new Request(fileUrl(mdPath), {
		method: "PUT",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"If-Match": `"${initialSha}"`,
		},
		body: Buffer.from(updated),
	});
	const res = await filePUT(req, makeCtx([mdPath]));
	assert.equal(res.status, 200);

	const sidecar = await readSidecar(tmpRoot, mdPath);
	const newFileSha = sha256(Buffer.from(updated));
	// Fingerprint MUST equal new sha (not old), proving eager reconcile ran
	assert.equal(sidecar!.fingerprint, newFileSha, "fingerprint updated eagerly");
});

test("PUT: mutate scope required (read-only agent rejected)", async () => {
	const req = new Request(fileUrl("some.txt"), {
		method: "PUT",
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
		body: Buffer.from("data"),
	});
	const res = await filePUT(req, makeCtx(["some.txt"]));
	assert.equal(res.status, 403);
});

// ── DELETE tests ──────────────────────────────────────────────────────────────

test("DELETE: requires delete scope — mutate-only agent gets 403", async () => {
	await writeFile(path.join(tmpRoot, "del-scope.txt"), "content");
	const buf = await readFile(path.join(tmpRoot, "del-scope.txt"));
	const sha = sha256(buf);

	const req = new Request(fileUrl("del-scope.txt"), {
		method: "DELETE",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"If-Match": `"${sha}"`,
		},
	});
	const res = await fileDELETE(req, makeCtx(["del-scope.txt"]));
	assert.equal(res.status, 403);
});

test("DELETE: requires If-Match header", async () => {
	await writeFile(path.join(tmpRoot, "del-nomatch.txt"), "content");
	const req = new Request(fileUrl("del-nomatch.txt"), {
		method: "DELETE",
		headers: agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
	});
	const res = await fileDELETE(req, makeCtx(["del-nomatch.txt"]));
	assert.equal(res.status, 412);
	const json = await res.json() as { error: string };
	assert.equal(json.error, "PRECONDITION_REQUIRED");
});

test("DELETE: If-Match mismatch → 412", async () => {
	await writeFile(path.join(tmpRoot, "del-mismatch.txt"), "content");
	const req = new Request(fileUrl("del-mismatch.txt"), {
		method: "DELETE",
		headers: {
			...agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
			"If-Match": `"sha256:${"0".repeat(64)}"`,
		},
	});
	const res = await fileDELETE(req, makeCtx(["del-mismatch.txt"]));
	assert.equal(res.status, 412);
});

test("DELETE: file with correct If-Match deleted", async () => {
	const content = Buffer.from("to be deleted");
	await writeFile(path.join(tmpRoot, "deleteme.txt"), content);
	const sha = sha256(content);

	const req = new Request(fileUrl("deleteme.txt"), {
		method: "DELETE",
		headers: {
			...agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
			"If-Match": `"${sha}"`,
		},
	});
	const res = await fileDELETE(req, makeCtx(["deleteme.txt"]));
	assert.equal(res.status, 200);

	// File gone
	await assert.rejects(
		() => readFile(path.join(tmpRoot, "deleteme.txt")),
		{ code: "ENOENT" },
	);
});

test("DELETE: .md deletion also removes sidecar", async () => {
	const mdPath = "delete-with-sidecar.md";
	const content = Buffer.from("# Delete me\n");
	await writeFile(path.join(tmpRoot, mdPath), content);
	const sc = emptySidecar(mdPath);
	await writeSidecar(tmpRoot, mdPath, sc);
	const sha = sha256(content);

	const req = new Request(fileUrl(mdPath), {
		method: "DELETE",
		headers: {
			...agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
			"If-Match": `"${sha}"`,
		},
	});
	const res = await fileDELETE(req, makeCtx([mdPath]));
	assert.equal(res.status, 200);

	// Both file and sidecar gone
	await assert.rejects(
		() => readFile(path.join(tmpRoot, mdPath)),
		{ code: "ENOENT" },
	);
	const sidecarAfter = await readSidecar(tmpRoot, mdPath);
	assert.equal(sidecarAfter, null, "sidecar deleted alongside .md");
});

test("DELETE: directory without ?recursive → 400", async () => {
	await mkdir(path.join(tmpRoot, "nodirdel"), { recursive: true });
	const req = new Request(fileUrl("nodirdel"), {
		method: "DELETE",
		headers: {
			...agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
			"If-Match": '"anything"',
		},
	});
	const res = await fileDELETE(req, makeCtx(["nodirdel"]));
	assert.equal(res.status, 400);
	const json = await res.json() as { error: string };
	assert.equal(json.error, "IS_DIRECTORY");
});

test("DELETE: directory with ?recursive=true succeeds", async () => {
	await mkdir(path.join(tmpRoot, "recdel"), { recursive: true });
	await writeFile(path.join(tmpRoot, "recdel/file.txt"), "hi");
	const req = new Request(fileUrl("recdel", "?recursive=true"), {
		method: "DELETE",
		headers: agentHeaders(DELETE_TOKEN, "ai:delete-agent"),
	});
	const res = await fileDELETE(req, makeCtx(["recdel"]));
	assert.equal(res.status, 200);
});

// ── ls tests ──────────────────────────────────────────────────────────────────

test("ls: lists files in directory", async () => {
	await mkdir(path.join(tmpRoot, "ls-dir"), { recursive: true });
	await writeFile(path.join(tmpRoot, "ls-dir/a.txt"), "a");
	await writeFile(path.join(tmpRoot, "ls-dir/b.md"), "# b");

	const req = new Request(lsUrl("ls-dir"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await lsGET(req, makeLsCtx(["ls-dir"]));
	assert.equal(res.status, 200);
	const json = await res.json() as { entries: Array<{ name: string }> };
	const names = json.entries.map((e) => e.name).sort();
	assert.deepEqual(names, ["a.txt", "b.md"]);
});

test("ls: excludes .proof/ from results", async () => {
	// .proof dir may already exist from other tests — just check it's not listed
	await mkdir(path.join(tmpRoot, ".proof"), { recursive: true });
	await writeFile(path.join(tmpRoot, ".proof/test.json"), "{}");

	const req = new Request(lsUrl(""), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await lsGET(req, makeLsCtx([]));
	assert.equal(res.status, 200);
	const json = await res.json() as { entries: Array<{ name: string }> };
	const hasProof = json.entries.some((e) => e.name === ".proof");
	assert.equal(hasProof, false, ".proof should be excluded");
});

test("ls: scope-filters entries — restricted agent only sees allowed/", async () => {
	await mkdir(path.join(tmpRoot, "allowed"), { recursive: true });
	await writeFile(path.join(tmpRoot, "allowed/ok.txt"), "yes");
	await writeFile(path.join(tmpRoot, "not-allowed.txt"), "no");

	const req = new Request(lsUrl(""), {
		headers: agentHeaders(RESTRICTED_TOKEN, "ai:restricted"),
	});
	const res = await lsGET(req, makeLsCtx([]));
	assert.equal(res.status, 200);
	const json = await res.json() as { entries: Array<{ name: string; path: string }> };
	// Restricted agent has scope "allowed/**" — not-allowed.txt should be absent
	const notAllowed = json.entries.find((e) => e.name === "not-allowed.txt");
	assert.equal(notAllowed, undefined, "out-of-scope file hidden from restricted agent");
});

test("ls: recursive=true traverses subdirs", async () => {
	await mkdir(path.join(tmpRoot, "rec/sub"), { recursive: true });
	await writeFile(path.join(tmpRoot, "rec/top.txt"), "top");
	await writeFile(path.join(tmpRoot, "rec/sub/deep.txt"), "deep");

	const req = new Request(lsUrl("rec", "?recursive"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await lsGET(req, makeLsCtx(["rec"]));
	assert.equal(res.status, 200);
	const json = await res.json() as { entries: Array<{ path: string }> };
	const paths = json.entries.map((e) => e.path);
	assert.ok(paths.some((p) => p.includes("deep.txt")), "deep.txt found in recursive listing");
});

test("ls: limit is respected", async () => {
	await mkdir(path.join(tmpRoot, "limit-dir"), { recursive: true });
	for (let i = 0; i < 10; i++) {
		await writeFile(path.join(tmpRoot, `limit-dir/f${i}.txt`), String(i));
	}

	const req = new Request(lsUrl("limit-dir", "?limit=3"), {
		headers: agentHeaders(READ_TOKEN, "ai:read-agent"),
	});
	const res = await lsGET(req, makeLsCtx(["limit-dir"]));
	assert.equal(res.status, 200);
	const json = await res.json() as { entries: unknown[]; truncated: boolean };
	assert.equal(json.entries.length, 3);
	assert.equal(json.truncated, true);
});

// ── move tests ────────────────────────────────────────────────────────────────

test("move: renames a file", async () => {
	await writeFile(path.join(tmpRoot, "move-src.txt"), "data");

	const req = new Request("http://localhost/api/agent/fs/move", {
		method: "POST",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: "move-src.txt", to: "move-dst.txt" }),
	});
	const res = await movePOST(req);
	assert.equal(res.status, 200);

	const dst = await readFile(path.join(tmpRoot, "move-dst.txt"), "utf-8");
	assert.equal(dst, "data");
	await assert.rejects(
		() => readFile(path.join(tmpRoot, "move-src.txt")),
		{ code: "ENOENT" },
	);
});

test("move: moves sidecar alongside .md", async () => {
	const fromMd = "move-from.md";
	const toMd = "move-to.md";
	await writeFile(path.join(tmpRoot, fromMd), "# From\n");
	const sc = emptySidecar(fromMd);
	sc.revision = 5;
	await writeSidecar(tmpRoot, fromMd, sc);

	const req = new Request("http://localhost/api/agent/fs/move", {
		method: "POST",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: fromMd, to: toMd }),
	});
	const res = await movePOST(req);
	assert.equal(res.status, 200);

	// Source sidecar gone, dest sidecar present with correct data
	const fromSidecar = await readSidecar(tmpRoot, fromMd);
	assert.equal(fromSidecar, null, "source sidecar removed");
	const toSidecar = await readSidecar(tmpRoot, toMd);
	assert.ok(toSidecar, "destination sidecar present");
	assert.equal(toSidecar!.revision, 5);
});

test("move: If-Match mismatch → 412", async () => {
	await writeFile(path.join(tmpRoot, "move-ifmatch.txt"), "content");

	const req = new Request("http://localhost/api/agent/fs/move", {
		method: "POST",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: "move-ifmatch.txt", to: "move-ifmatch-dst.txt", ifMatch: "sha256:" + "0".repeat(64) }),
	});
	const res = await movePOST(req);
	assert.equal(res.status, 412);
});

test("move: 404 when source doesn't exist", async () => {
	const req = new Request("http://localhost/api/agent/fs/move", {
		method: "POST",
		headers: {
			...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: "no-such-file.txt", to: "dst.txt" }),
	});
	const res = await movePOST(req);
	assert.equal(res.status, 404);
});

// ── search tests ──────────────────────────────────────────────────────────────

test("search grep: finds pattern in files", async () => {
	await mkdir(path.join(tmpRoot, "grep-dir"), { recursive: true });
	await writeFile(path.join(tmpRoot, "grep-dir/alpha.txt"), "hello world\nfoo bar\n");
	await writeFile(path.join(tmpRoot, "grep-dir/beta.txt"), "no match here\nhello again\n");

	const req = new Request("http://localhost/api/agent/fs/search", {
		method: "POST",
		headers: {
			...agentHeaders(READ_TOKEN, "ai:read-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ kind: "grep", query: "hello", path: "grep-dir" }),
	});
	const res = await searchPOST(req);
	assert.equal(res.status, 200);
	const json = await res.json() as { matches: Array<{ path: string; line: number }> };
	assert.ok(json.matches.length >= 2, "both matches found");
	assert.ok(json.matches.every((m) => m.path.startsWith("grep-dir/")));
});

test("search grep: skips binary files", async () => {
	await mkdir(path.join(tmpRoot, "bin-dir"), { recursive: true });
	// Binary file (has null byte)
	const binBuf = Buffer.from([0x00, 0x01, 0x02, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // null + "hello"
	await writeFile(path.join(tmpRoot, "bin-dir/binary.bin"), binBuf);
	await writeFile(path.join(tmpRoot, "bin-dir/text.txt"), "hello from text");

	const req = new Request("http://localhost/api/agent/fs/search", {
		method: "POST",
		headers: {
			...agentHeaders(READ_TOKEN, "ai:read-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ kind: "grep", query: "hello", path: "bin-dir" }),
	});
	const res = await searchPOST(req);
	assert.equal(res.status, 200);
	const json = await res.json() as { matches: Array<{ path: string }> };
	// Binary file skipped, only text.txt matches
	assert.ok(json.matches.every((m) => !m.path.endsWith(".bin")), "binary file skipped");
	assert.ok(json.matches.some((m) => m.path.endsWith("text.txt")), "text file found");
});

test("search glob: finds files matching pattern", async () => {
	await mkdir(path.join(tmpRoot, "glob-dir"), { recursive: true });
	await writeFile(path.join(tmpRoot, "glob-dir/a.md"), "# A");
	await writeFile(path.join(tmpRoot, "glob-dir/b.ts"), "const x = 1;");
	await writeFile(path.join(tmpRoot, "glob-dir/c.md"), "# C");

	const req = new Request("http://localhost/api/agent/fs/search", {
		method: "POST",
		headers: {
			...agentHeaders(READ_TOKEN, "ai:read-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ kind: "glob", query: "*.md", path: "glob-dir" }),
	});
	const res = await searchPOST(req);
	assert.equal(res.status, 200);
	const json = await res.json() as { matches: Array<{ path: string }> };
	assert.ok(json.matches.length >= 2, "both .md files found");
	assert.ok(json.matches.every((m) => m.path.endsWith(".md")), "only .md files returned");
});

test("search: scope-rechecks each result — restricted agent only sees allowed/ files", async () => {
	await mkdir(path.join(tmpRoot, "allowed/search-sub"), { recursive: true });
	await writeFile(path.join(tmpRoot, "allowed/search-sub/in-scope.txt"), "find me");
	await writeFile(path.join(tmpRoot, "out-of-scope-search.txt"), "find me too");

	const req = new Request("http://localhost/api/agent/fs/search", {
		method: "POST",
		headers: {
			...agentHeaders(RESTRICTED_TOKEN, "ai:restricted"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ kind: "grep", query: "find me" }),
	});
	const res = await searchPOST(req);
	assert.equal(res.status, 200);
	const json = await res.json() as { matches: Array<{ path: string }> };
	// out-of-scope-search.txt must not appear
	const hasOutOfScope = json.matches.some((m) => m.path.includes("out-of-scope-search"));
	assert.equal(hasOutOfScope, false, "out-of-scope file hidden from restricted agent");
});

test("search: invalid regex → 400", async () => {
	const req = new Request("http://localhost/api/agent/fs/search", {
		method: "POST",
		headers: {
			...agentHeaders(READ_TOKEN, "ai:read-agent"),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ kind: "grep", query: "[invalid" }),
	});
	const res = await searchPOST(req);
	assert.equal(res.status, 400);
});

// ── Path safety (traversal + symlink) ────────────────────────────────────────

test("traversal: PUT rejects ../ path", async () => {
	const req = new Request(fileUrl("../outside.txt"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("escape attempt"),
	});
	const res = await filePUT(req, makeCtx(["../outside.txt"]));
	assert.equal(res.status, 400);
});

test("symlink escape: PUT rejects symlink pointing outside root", async () => {
	// Create a symlink inside root pointing outside
	const escapedDir = await mkdtemp(path.join(tmpdir(), "escape-target-"));
	try {
		const symlinkPath = path.join(tmpRoot, "escape-link");
		try {
			await symlink(escapedDir, symlinkPath);
		} catch {
			// symlink already exists from prior run
		}

		const req = new Request(fileUrl("escape-link/secret.txt"), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
			body: Buffer.from("escaped!"),
		});
		const res = await filePUT(req, makeCtx(["escape-link", "secret.txt"]));
		// Should reject: symlink escapes root
		assert.equal(res.status, 400);
	} finally {
		await rm(escapedDir, { recursive: true, force: true });
	}
});

test("traversal: .proof/ denied on PUT", async () => {
	const req = new Request(fileUrl(".proof/inject.json"), {
		method: "PUT",
		headers: agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"),
		body: Buffer.from("{}"),
	});
	const res = await filePUT(req, makeCtx([".proof", "inject.json"]));
	assert.equal(res.status, 400);
});

// ── PATCH (server-side str-replace) ──────────────────────────────────────────

test("PATCH: str-replace on .md succeeds, sends only find/replace", async () => {
	const orig = Buffer.from("# Title\n\nHello world. Keep this.\n");
	await writeFile(path.join(tmpRoot, "patch1.md"), orig);
	const req = new Request(fileUrl("patch1.md"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "Hello world", replace: "Goodbye moon" }),
	});
	const res = await filePATCH(req, makeCtx(["patch1.md"]));
	assert.equal(res.status, 200, await res.text());
	const out = await readFile(path.join(tmpRoot, "patch1.md"), "utf-8");
	assert.equal(out, "# Title\n\nGoodbye moon. Keep this.\n");
});

test("PATCH: missing If-Match → 412", async () => {
	const orig = Buffer.from("alpha beta gamma");
	await writeFile(path.join(tmpRoot, "patch2.txt"), orig);
	const req = new Request(fileUrl("patch2.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json" },
		body: JSON.stringify({ find: "beta", replace: "BETA" }),
	});
	const res = await filePATCH(req, makeCtx(["patch2.txt"]));
	assert.equal(res.status, 412);
});

test("PATCH: If-Match mismatch → 412", async () => {
	const orig = Buffer.from("alpha beta gamma");
	await writeFile(path.join(tmpRoot, "patch3.txt"), orig);
	const req = new Request(fileUrl("patch3.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": "sha256:deadbeef" },
		body: JSON.stringify({ find: "beta", replace: "BETA" }),
	});
	const res = await filePATCH(req, makeCtx(["patch3.txt"]));
	assert.equal(res.status, 412);
});

test("PATCH: zero matches → 422 MATCH_COUNT_MISMATCH", async () => {
	const orig = Buffer.from("alpha beta gamma");
	await writeFile(path.join(tmpRoot, "patch4.txt"), orig);
	const req = new Request(fileUrl("patch4.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "nonexistent", replace: "x" }),
	});
	const res = await filePATCH(req, makeCtx(["patch4.txt"]));
	assert.equal(res.status, 422);
	const j = await res.json();
	assert.equal(j.error, "MATCH_COUNT_MISMATCH");
	assert.equal(j.found, 0);
});

test("PATCH: multiple matches but expected 1 → 422", async () => {
	const orig = Buffer.from("foo bar foo baz foo");
	await writeFile(path.join(tmpRoot, "patch5.txt"), orig);
	const req = new Request(fileUrl("patch5.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "foo", replace: "X" }),
	});
	const res = await filePATCH(req, makeCtx(["patch5.txt"]));
	assert.equal(res.status, 422);
	const j = await res.json();
	assert.equal(j.found, 3);
});

test("PATCH: expectedOccurrences matching multi replaces all", async () => {
	const orig = Buffer.from("foo bar foo baz foo");
	await writeFile(path.join(tmpRoot, "patch6.txt"), orig);
	const req = new Request(fileUrl("patch6.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "foo", replace: "X", expectedOccurrences: 3 }),
	});
	const res = await filePATCH(req, makeCtx(["patch6.txt"]));
	assert.equal(res.status, 200, await res.text());
	const out = await readFile(path.join(tmpRoot, "patch6.txt"), "utf-8");
	assert.equal(out, "X bar X baz X");
});

test("PATCH: empty find → 400", async () => {
	const orig = Buffer.from("abc");
	await writeFile(path.join(tmpRoot, "patch7.txt"), orig);
	const req = new Request(fileUrl("patch7.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "", replace: "x" }),
	});
	const res = await filePATCH(req, makeCtx(["patch7.txt"]));
	assert.equal(res.status, 400);
});

test("PATCH: binary file → 415", async () => {
	const orig = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]);
	await writeFile(path.join(tmpRoot, "patch8.bin"), orig);
	const req = new Request(fileUrl("patch8.bin"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "x", replace: "y" }),
	});
	const res = await filePATCH(req, makeCtx(["patch8.bin"]));
	assert.equal(res.status, 415);
});

test("PATCH: nonexistent file → 404 (no create)", async () => {
	const req = new Request(fileUrl("patch-missing.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": "sha256:abc" },
		body: JSON.stringify({ find: "a", replace: "b" }),
	});
	const res = await filePATCH(req, makeCtx(["patch-missing.txt"]));
	assert.equal(res.status, 404);
});

test("PATCH: .md emits file.rawWritten + reconciles (same path as PUT)", async () => {
	const orig = Buffer.from("# H\n\noriginal paragraph here\n");
	await writeFile(path.join(tmpRoot, "patch-md.md"), orig);
	const req = new Request(fileUrl("patch-md.md"), {
		method: "PATCH",
		headers: { ...agentHeaders(MUTATE_TOKEN, "ai:mutate-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "original", replace: "updated" }),
	});
	const res = await filePATCH(req, makeCtx(["patch-md.md"]));
	assert.equal(res.status, 200, await res.text());
	const sidecar = await readSidecar(tmpRoot, "patch-md.md");
	assert.ok(sidecar, "sidecar created");
	const events = sidecar!.events.filter((e) => e.type === "file.rawWritten");
	assert.ok(events.length > 0, "file.rawWritten event present");
	const newContent = await readFile(path.join(tmpRoot, "patch-md.md"), "utf-8");
	assert.equal(sidecar!.fingerprint, sha256(Buffer.from(newContent)), "fingerprint matches new content (eager reconcile)");
});

test("PATCH: requires mutate scope", async () => {
	const orig = Buffer.from("hello");
	await writeFile(path.join(tmpRoot, "patch-scope.txt"), orig);
	const req = new Request(fileUrl("patch-scope.txt"), {
		method: "PATCH",
		headers: { ...agentHeaders(READ_TOKEN, "ai:read-agent"), "Content-Type": "application/json", "If-Match": sha256(orig) },
		body: JSON.stringify({ find: "hello", replace: "hi" }),
	});
	const res = await filePATCH(req, makeCtx(["patch-scope.txt"]));
	assert.equal(res.status, 403);
});
