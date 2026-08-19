/** Paths for the installed Impeccable live engine. */
import os from "node:os";
import path from "node:path";

const DEFAULT_SCRIPTS_DIR = path.join(
	os.homedir(),
	".pi",
	"agent",
	"skills",
	"impeccable",
	"scripts",
);

/** Resolve the Impeccable scripts directory, with an injectable test override. */
export function impeccableScriptsDir(): string {
	return process.env.IMPECCABLE_SCRIPTS_DIR || DEFAULT_SCRIPTS_DIR;
}

/** Absolute path to the helper server entry point. */
export function liveServerScript(): string {
	return path.join(impeccableScriptsDir(), "live-server.mjs");
}

/** Absolute path to the Impeccable preparation CLI. */
export function liveScript(): string {
	return path.join(impeccableScriptsDir(), "live.mjs");
}

export interface LiveEngineKey {
	workspaceId: string;
	relPath: string;
}

/** Stable, workspace-scoped key used by the lifecycle supervisor. */
export function liveEngineKey(key: LiveEngineKey): string {
	return `${key.workspaceId}\0${key.relPath}`;
}
