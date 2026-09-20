import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Block, Sidecar } from "./types";
import { migrateSidecar } from "./anchor";

export function sidecarPath(rootDir: string, mdPath: string): string {
	return path.join(rootDir, ".proof", mdPath + ".json");
}

/**
 * Read a sidecar, upgrading an older schema in memory.
 *
 * The upgrade is NOT persisted here: this is a read, and writing during a read is what
 * made the file watcher reload the document out from under the user on every keystroke.
 * A sidecar is written back by the operation that next mutates it, at which point the
 * migrated shape is what gets stored.
 */
export async function readSidecar(
	rootDir: string,
	mdPath: string,
	blocks: Block[] = [],
): Promise<Sidecar | null> {
	const filePath = sidecarPath(rootDir, mdPath);
	try {
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Sidecar;
		if (![1, 2, 3].includes(parsed.schemaVersion)) {
			throw new Error(
				`Sidecar schema version mismatch: expected 1, 2 or 3, got ${parsed.schemaVersion}`,
			);
		}
		const migrated = parsed.anchors ? parsed : { ...parsed, anchors: {} };
		const { sidecar } = migrateSidecar(migrated, blocks);
		return sidecar;
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw err;
	}
}

export async function writeSidecar(
	rootDir: string,
	mdPath: string,
	sc: Sidecar,
): Promise<void> {
	const dest = sidecarPath(rootDir, mdPath);
	await mkdir(path.dirname(dest), { recursive: true });
	const tmp = dest + ".tmp";
	await writeFile(tmp, JSON.stringify(sc, null, 2), "utf-8");
	await rename(tmp, dest);
}

/**
 * Move a sidecar file alongside a renamed .md file.
 * No-op if the sidecar does not exist.
 */
export async function moveSidecar(
	rootDir: string,
	fromMdPath: string,
	toMdPath: string,
): Promise<void> {
	const src = sidecarPath(rootDir, fromMdPath);
	const dest = sidecarPath(rootDir, toMdPath);
	try {
		await mkdir(path.dirname(dest), { recursive: true });
		await rename(src, dest);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no sidecar — ok
		throw err;
	}
}

/**
 * Delete a sidecar file for a removed .md file.
 * No-op if the sidecar does not exist.
 */
export async function deleteSidecar(
	rootDir: string,
	mdPath: string,
): Promise<void> {
	const filePath = sidecarPath(rootDir, mdPath);
	try {
		await unlink(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already gone — ok
		throw err;
	}
}

export function emptySidecar(mdPath: string): Sidecar {
	const now = new Date().toISOString();
	return {
		schemaVersion: 3,
		anchors: {},
		path: mdPath,
		revision: 0,
		createdAt: now,
		updatedAt: now,
		refMap: {},
		refAliases: {},
		comments: [],
		suggestions: [],
		archivedSuggestions: [],
		events: [],
		nextEventId: 1,
		lastAck: {},
		fingerprint: "",
	};
}
