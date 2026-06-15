import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseSshTarget,
	isValidKeyPath,
	buildSshfsArgs,
	mountpointFor,
	mountsDir,
} from "../../lib/sshfs.js";

// ── parseSshTarget ────────────────────────────────────────────────────────────

test("parseSshTarget: user@host:/path", () => {
	const p = parseSshTarget("alice@server.example.com:/srv/notes");
	assert.deepEqual(p, {
		user: "alice",
		host: "server.example.com",
		remotePath: "/srv/notes",
	});
});

test("parseSshTarget: host without user", () => {
	const p = parseSshTarget("box:/home/data");
	assert.deepEqual(p, { user: undefined, host: "box", remotePath: "/home/data" });
});

test("parseSshTarget: IPv4 host", () => {
	const p = parseSshTarget("root@10.0.0.5:/var/www");
	assert.equal(p?.host, "10.0.0.5");
	assert.equal(p?.user, "root");
});

test("parseSshTarget rejects relative remote path", () => {
	assert.equal(parseSshTarget("host:notes"), null);
});

test("parseSshTarget rejects path traversal", () => {
	assert.equal(parseSshTarget("host:/srv/../etc"), null);
});

test("parseSshTarget rejects shell metacharacters", () => {
	for (const bad of [
		"host:/srv;rm -rf /",
		"host:/srv`whoami`",
		"ho|st:/srv",
		"host:/srv$(id)",
		"host:/srv\n/x",
	]) {
		assert.equal(parseSshTarget(bad), null, bad);
	}
});

test("parseSshTarget rejects missing colon / empty host", () => {
	assert.equal(parseSshTarget("justahost"), null);
	assert.equal(parseSshTarget(":/path"), null);
	assert.equal(parseSshTarget("@host:/path"), null);
});

// ── isValidKeyPath ────────────────────────────────────────────────────────────

test("isValidKeyPath accepts absolute and ~ paths", () => {
	assert.equal(isValidKeyPath("/home/u/.ssh/id_ed25519"), true);
	assert.equal(isValidKeyPath("~/.ssh/id_rsa"), true);
});

test("isValidKeyPath rejects relative, traversal, metachars", () => {
	assert.equal(isValidKeyPath("id_rsa"), false);
	assert.equal(isValidKeyPath("~/../etc/shadow"), false);
	assert.equal(isValidKeyPath("/k;rm"), false);
});

// ── buildSshfsArgs ────────────────────────────────────────────────────────────

const target = { user: "u", host: "h", remotePath: "/p" } as const;

test("buildSshfsArgs: agent auth, default options", () => {
	const args = buildSshfsArgs({
		mountpoint: "/mnt/x",
		target,
		authMethod: "agent",
	});
	assert.equal(args[0], "u@h:/p");
	assert.equal(args[1], "/mnt/x");
	const o = args[args.indexOf("-o") + 1];
	assert.match(o, /reconnect/);
	assert.match(o, /BatchMode=yes/);
	assert.doesNotMatch(o, /password_stdin/);
	assert.doesNotMatch(o, /\bro\b/);
});

test("buildSshfsArgs: port flag", () => {
	const args = buildSshfsArgs({
		mountpoint: "/mnt/x",
		target,
		port: 2222,
		authMethod: "agent",
	});
	assert.ok(args.includes("-p"));
	assert.equal(args[args.indexOf("-p") + 1], "2222");
});

test("buildSshfsArgs: read-only adds ro", () => {
	const args = buildSshfsArgs({
		mountpoint: "/mnt/x",
		target,
		authMethod: "agent",
		readOnly: true,
	});
	const o = args[args.indexOf("-o") + 1];
	assert.match(o, /(^|,)ro(,|$)/);
});

test("buildSshfsArgs: keyfile sets IdentityFile + IdentitiesOnly", () => {
	const args = buildSshfsArgs({
		mountpoint: "/mnt/x",
		target,
		authMethod: "keyfile",
		keyPath: "/home/u/.ssh/id_ed25519",
	});
	const o = args[args.indexOf("-o") + 1];
	assert.match(o, /IdentityFile=\/home\/u\/\.ssh\/id_ed25519/);
	assert.match(o, /IdentitiesOnly=yes/);
});

test("buildSshfsArgs: password sets password_stdin and drops BatchMode", () => {
	const args = buildSshfsArgs({
		mountpoint: "/mnt/x",
		target,
		authMethod: "password",
		password: "secret",
	});
	const o = args[args.indexOf("-o") + 1];
	assert.match(o, /password_stdin/);
	assert.match(o, /PubkeyAuthentication=no/);
	assert.doesNotMatch(o, /BatchMode=yes/);
	// Password must never appear on argv.
	assert.ok(!args.some((a) => a.includes("secret")));
});

// ── mount path helpers ────────────────────────────────────────────────────────

test("mountpointFor is under mountsDir", () => {
	const mp = mountpointFor("ws_abc");
	assert.ok(mp.startsWith(mountsDir() + "/"));
	assert.ok(mp.endsWith("ws_abc"));
});
