import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sidecar } from "./types";
import type { ActivityEvent } from "./activity-shared";
import {
	ACTIVITY_DEFAULT_LIMIT,
	ACTIVITY_MAX_LIMIT,
	deriveConnections,
} from "./activity-shared";

export type { ActivityEvent } from "./activity-shared";
export {
	ACTIVITY_DEFAULT_LIMIT,
	ACTIVITY_MAX_LIMIT,
	deriveConnections,
};

/** Walk rootDir/.proof/, merge events from all sidecars, sort newest first. */
export async function aggregateActivity(
	rootDir: string,
	options?: { limit?: number; file?: string },
): Promise<ActivityEvent[]> {
	const limit = Math.min(
		options?.limit ?? ACTIVITY_DEFAULT_LIMIT,
		ACTIVITY_MAX_LIMIT,
	);
	const fileFilter = options?.file ?? null;

	const proofDir = path.join(rootDir, ".proof");

	let allEvents: ActivityEvent[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				let sc: Sidecar;
				try {
					const raw = await readFile(fullPath, "utf-8");
					sc = JSON.parse(raw) as Sidecar;
					if (sc.schemaVersion !== 1) continue;
				} catch {
					continue;
				}
				if (fileFilter && sc.path !== fileFilter) continue;
				const events: ActivityEvent[] = (sc.events ?? []).map((ev) => ({
					...ev,
					path: sc.path,
				}));
				allEvents = allEvents.concat(events);
			}
		}
	}

	await walk(proofDir);

	allEvents.sort((a, b) => {
		if (a.at < b.at) return 1;
		if (a.at > b.at) return -1;
		return 0;
	});

	return allEvents.slice(0, limit);
}


