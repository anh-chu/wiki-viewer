/**
 * Shared SSH target parsing and sshfs argv construction.
 *
 * This module is consumed by both the Node/JS CLI (`bin/wiki-viewer.js`) and
 * the TypeScript server (`src/lib/sshfs.ts`) via direct import, so the logic
 * stays in one place and cannot drift. It exports defensive validators only —
 * it never calls `process.exit`.
 */

import { existsSync } from "node:fs";

// Defense-in-depth: reject these even though callers never pass fields through
// a shell.
export const FORBIDDEN_SSH_CHARS = new RegExp("[;|&$`<>(){}\\n\\r\\0]");

/**
 * @typedef {Object} ParsedSshTarget
 * @property {string} [user]
 * @property {string} host
 * @property {string} remotePath
 */

/**
 * @typedef {"agent" | "keyfile" | "password"} SshAuthMethod
 */

/**
 * @typedef {Object} BuildSshfsOptions
 * @property {ParsedSshTarget} target
 * @property {string} mountpoint
 * @property {number | string} [port]
 * @property {SshAuthMethod} [authMethod]
 * @property {string} [keyPath]
 * @property {string} [password]
 * @property {boolean} [readOnly]
 * @property {string[]} [extraOptions]
 */

/**
 * Heuristic used by the CLI to decide whether a positional argument should be
 * treated as a directory or as an SSH target.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function looksLikeSshTarget(s) {
	if (!s || FORBIDDEN_SSH_CHARS.test(s)) return false;
	// [user@]host:/abs/path — host has no slash, remote path is absolute. An
	// existing local path (e.g. a real dir literally named like this) wins.
	return /^([\w.-]+@)?[\w.-]+:\/.+/.test(s) && !existsSync(s);
}

/**
 * Parse an SSH target of the form `[user@]host:/abs/path`.
 *
 * @param {string} target
 * @returns {ParsedSshTarget | null}
 */
export function parseSshTarget(target) {
	if (!target || FORBIDDEN_SSH_CHARS.test(target)) return null;
	const trimmed = target.trim();

	const colon = trimmed.indexOf(":");
	if (colon <= 0) return null;
	const hostPart = trimmed.slice(0, colon);
	const remotePath = trimmed.slice(colon + 1);

	if (!remotePath.startsWith("/")) return null;
	if (remotePath.includes("..")) return null;

	let user;
	let host = hostPart;
	const at = hostPart.indexOf("@");
	if (at >= 0) {
		user = hostPart.slice(0, at);
		host = hostPart.slice(at + 1);
		if (!user) return null;
	}
	if (!host) return null;
	if (!/^[a-zA-Z0-9.\-]+$/.test(host)) return null;
	if (user && !/^[a-zA-Z0-9._\-]+$/.test(user)) return null;

	return { user, host, remotePath };
}

/**
 * Validate an explicit private key path.
 *
 * @param {string} keyPath
 * @returns {boolean}
 */
export function isValidKeyPath(keyPath) {
	if (!keyPath || FORBIDDEN_SSH_CHARS.test(keyPath)) return false;
	if (keyPath.includes("..")) return false;
	return keyPath.startsWith("/") || keyPath.startsWith("~/");
}

/**
 * Build the sshfs argv (excluding the binary name).
 *
 * @param {BuildSshfsOptions} opts
 * @returns {string[]}
 */
export function buildSshfsArgs(opts) {
	const { target, mountpoint, port } = opts;
	const userPart = target.user ? `${target.user}@` : "";
	const args = [`${userPart}${target.host}:${target.remotePath}`, mountpoint];

	if (
		port &&
		Number.isInteger(Number(port)) &&
		Number(port) > 0 &&
		Number(port) < 65536
	) {
		args.push("-p", String(port));
	}

	// Infer authentication method if the caller did not provide an explicit one.
	/** @type {SshAuthMethod} */
	let authMethod = opts.authMethod ?? "agent";
	if (!opts.authMethod) {
		if (opts.password != null) authMethod = "password";
		else if (opts.keyPath) authMethod = "keyfile";
	}

	const o = [
		"reconnect",
		"ServerAliveInterval=15",
		"ServerAliveCountMax=3",
		"compression=yes",
		"cache=yes",
		"kernel_cache",
		"StrictHostKeyChecking=accept-new",
		"BatchMode=yes",
	];

	if (opts.readOnly) o.push("ro");
	if (authMethod === "keyfile" && opts.keyPath) {
		o.push(`IdentityFile=${opts.keyPath}`);
		o.push("IdentitiesOnly=yes");
	}
	if (authMethod === "password") {
		const idx = o.indexOf("BatchMode=yes");
		if (idx >= 0) o.splice(idx, 1);
		o.push("password_stdin");
		o.push("PreferredAuthentications=password,keyboard-interactive");
		o.push("PubkeyAuthentication=no");
		o.push("NumberOfPasswordPrompts=1");
	}
	if (opts.extraOptions) o.push(...opts.extraOptions);

	args.push("-o", o.join(","));
	return args;
}
