import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface WikiViewerConfig {
	pinnedPaths?: string[];
	lastOpenedPath?: string;
}

function configPath() {
	return path.join(os.homedir(), ".wiki-viewer", "config.json");
}

async function ensureDir() {
	await mkdir(path.join(os.homedir(), ".wiki-viewer"), { recursive: true });
}

export async function readConfig(): Promise<WikiViewerConfig> {
	try {
		const raw = await readFile(configPath(), "utf8");
		return JSON.parse(raw) as WikiViewerConfig;
	} catch {
		return {};
	}
}

export async function writeConfig(patch: Partial<WikiViewerConfig>): Promise<void> {
	await ensureDir();
	const existing = await readConfig();
	const next = { ...existing, ...patch };
	await writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
}
