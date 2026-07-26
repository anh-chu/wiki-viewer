/**
 * Resolve the ripgrep binary once per process, cached.
 *
 * Resolution order (first hit wins):
 *   1. process.env.WIKI_VIEWER_RG — explicit operator override; must be statSync
 *      and executable.
 *   2. Bundled @vscode/ripgrep platform package — resolved via createRequire
 *      from the wrapper's directory, then via fs probe of the platform package's
 *      bin/ directory walking up from process.cwd() and from
 *      path.dirname(process.execPath), at most 5 levels. Deliberately does NOT
 *      require("@vscode/ripgrep") — Next/Turbopack externalisation of that
 *      package is unreliable here.
 *   3. `rg` on PATH, verified with execFile("rg", ["--version"]).
 *
 * Never throws. null means degraded mode — callers surface it, don't crash.
 */
import { execFile as _execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(_execFile);

let _rgPath: string | null | undefined;

function isExecutableFile(p: string): boolean {
	try {
		const st = statSync(p);
		return st.isFile() && (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function walkUpFind(dir: string, levels: number, target: string): string | null {
	let current = path.resolve(dir);
	for (let i = 0; i <= levels; i++) {
		const candidate = path.join(current, target);
		if (isExecutableFile(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

async function probePath(): Promise<string | null> {
	try {
		await execFile("rg", ["--version"]);
		return "rg";
	} catch {
		return null;
	}
}

/**
 * Resolve the absolute path to a ripgrep binary. Cached after first call.
 * Returns null when no binary is available — callers must handle degraded mode.
 */
export async function resolveRgPath(): Promise<string | null> {
	if (_rgPath !== undefined) return _rgPath;

	// (a) explicit override
	const envRg = process.env.WIKI_VIEWER_RG;
	if (envRg && isExecutableFile(envRg)) {
		_rgPath = envRg;
		return _rgPath;
	}

	// (b) bundled @vscode/ripgrep platform package
	const arch = process.env.npm_config_arch || process.arch;
	const binName = process.platform === "win32" ? "rg.exe" : "rg";
	const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;

	// b.1 createRequire from the wrapper's directory — same mechanism the
	//     wrapper's own index.js uses. import.meta.resolve locates the
	//     wrapper without importing it.
	try {
		const wrapperFile = fileURLToPath(import.meta.resolve("@vscode/ripgrep"));
		const req = createRequire(wrapperFile);
		const resolved = req.resolve(`${platformPkg}/bin/${binName}`);
		if (isExecutableFile(resolved)) {
			_rgPath = resolved;
			return _rgPath;
		}
	} catch {
		// import.meta.resolve, fileURLToPath, or createRequire unavailable,
		// or resolve failed — fall through to fs probe
	}

	// b.2 fs probe — works when require.resolve is unavailable (e.g. in
	//     Next bundled output) and in the standalone bundle where
	//     postbuild.js places the binary at a known flat path
	const bundledRel = path.join("node_modules", platformPkg, "bin", binName);
	const fromCwd = walkUpFind(process.cwd(), 5, bundledRel);
	if (fromCwd) {
		_rgPath = fromCwd;
		return _rgPath;
	}
	const execDir = path.dirname(process.execPath);
	if (execDir !== process.cwd()) {
		const fromExec = walkUpFind(execDir, 5, bundledRel);
		if (fromExec) {
			_rgPath = fromExec;
			return _rgPath;
		}
	}

	// (c) PATH
	const onPath = await probePath();
	_rgPath = onPath; // "rg" string or null
	return _rgPath;
}

/** True when ripgrep is available. */
export async function rgAvailable(): Promise<boolean> {
	return (await resolveRgPath()) !== null;
}

/** Test hook: clear the cached resolution. */
export function _resetRgPath(): void {
	_rgPath = undefined;
}
