/**
 * Cheap, cached, synchronous view of the kernel mount table.
 *
 * Used to make both the watcher and the indexer walk blind to nested mount
 * points that can block indefinitely on a dead FUSE or network peer.
 *
 * /proc is a virtual filesystem — reading it cannot block on a dead mount,
 * which is exactly why sync is safe here and why probeLive must never be
 * called from this module.
 */
import { readFileSync, readdirSync } from "node:fs";
import { mountsDir } from "@/lib/sshfs";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MountEntry {
	mountPoint: string;
	fsType: string;
}

export interface MountPruner {
	/** True when absPath is prefixed by any nested hazard mount point. */
	isPruned(absPath: string): boolean;
	/** Re-read the mount table and rebuild the nested set. */
	refresh(): void;
	/** Return the current list of pruned mount points (for diagnostics). */
	list(): string[];
}

// ── Config ───────────────────────────────────────────────────────────────────

const MOUNT_CACHE_TTL_MS = 5000;

// ── Injectability ────────────────────────────────────────────────────────────

/** Internal read function, overridable for tests. */
let _readMountInfo: () => string = () => {
	try {
		return readFileSync("/proc/self/mountinfo", "utf8");
	} catch {
		return "";
	}
};

/** Override the mountinfo reader (test hook). Restore with resetMountReader(). */
export function _injectMountReader(fn: () => string): void {
	_readMountInfo = fn;
}

/** Restore the default /proc/self/mountinfo reader. */
export function _resetMountReader(): void {
	_readMountInfo = () => {
		try {
			return readFileSync("/proc/self/mountinfo", "utf8");
		} catch {
			return "";
		}
	};
}

// ── Cache ────────────────────────────────────────────────────────────────────

let _cache: { entries: MountEntry[]; ts: number } | null = null;

/** Clear the cached mount table (test hook). */
export function _clearMountCache(): void {
	_cache = null;
}

// ── Parse helpers ───────────────────────────────────────────────────────────

/** Decode octal escapes in mountinfo paths (\040 → space, etc.). */
function decodeOctalEscapes(s: string): string {
	return s.replace(/\\([0-7]{3})/g, (_m, oct) =>
		String.fromCharCode(parseInt(oct, 8)),
	);
}

/** Parse raw mountinfo text. */
function parseMountInfo(raw: string): MountEntry[] {
	const entries: MountEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const sepIdx = line.indexOf(" - ");
		if (sepIdx === -1) continue;
		const before = line.slice(0, sepIdx);
		const after = line.slice(sepIdx + 3);
		const beforeFields = before.split(" ");
		const afterFields = after.split(" ");
		// mount point is field 5 (0-indexed: 4) of the before part
		// fs type is field 1 (0-indexed: 0) of the after part
		if (beforeFields.length < 5 || afterFields.length < 1) continue;
		const mountPoint = decodeOctalEscapes(beforeFields[4]);
		const fsType = afterFields[0];
		entries.push({ mountPoint, fsType });
	}
	return entries;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Read and parse the kernel mount table. Cached for MOUNT_CACHE_TTL_MS. */
export function readMountTable(): MountEntry[] {
	const now = Date.now();
	if (_cache && now - _cache.ts < MOUNT_CACHE_TTL_MS) return _cache.entries;
	const raw = _readMountInfo();
	const entries = parseMountInfo(raw);
	_cache = { entries, ts: now };
	return entries;
}

/** True for FUSE and network filesystems that can block on a dead peer. */
export function isHazardFsType(fsType: string): boolean {
	if (fsType.startsWith("fuse")) return true; // fuse.sshfs, fuse.rclone, fuseblk
	switch (fsType) {
		case "nfs":
		case "nfs4":
		case "cifs":
		case "smb3":
		case "smbfs":
		case "afs":
		case "ceph":
		case "glusterfs":
		case "9p":
		case "davfs":
			return true;
		default:
			return false;
	}
}

/**
 * Hazardous mounts strictly inside rootDir.
 *
 * Excludes any mount point equal to rootDir or an ancestor of it — a
 * workspace whose own root is an sshfs mount stays fully watchable and
 * scannable. Only *nested* hazards are pruned.
 */
export function nestedHazardMounts(rootDir: string): string[] {
	const resolved = rootDir.endsWith("/") ? rootDir : rootDir + "/";
	const hazards = new Set<string>();

	// From kernel mount table
	for (const e of readMountTable()) {
		if (!isHazardFsType(e.fsType)) continue;
		// Strictly inside: must start with rootDir/ and be longer
		if (e.mountPoint.startsWith(resolved) && e.mountPoint.length > resolved.length) {
			hazards.add(e.mountPoint);
		}
	}

	// From the managed sshfs mounts directory — every entry under mountsDir()
	// that is strictly inside rootDir is a hazard regardless of mountinfo.
	try {
		const md = mountsDir();
		let entries: string[];
		try {
			entries = readdirSync(md);
		} catch {
			entries = [];
		}
		for (const name of entries) {
			const mp = md + "/" + name;
			if (mp.startsWith(resolved) && mp.length > resolved.length) {
				hazards.add(mp);
			}
		}
	} catch {
		// mountsDir() might not exist — ignore
	}

	return Array.from(hazards);
}

/**
 * Build a lightweight pruner for the given rootDir.
 *
 * isPruned is a prefix test against the cached nested-hazard set,
 * allocation-light, and must never call any async or blocking probe.
 */
export function makeMountPruner(rootDir: string): MountPruner {
	let hazards: string[] = [];

	function rebuild(): void {
		hazards = nestedHazardMounts(rootDir).sort();
	}

	const pruner: MountPruner = {
		isPruned(absPath: string): boolean {
			for (const mp of hazards) {
				if (absPath === mp) return true;
				if (absPath.startsWith(mp + "/")) return true;
			}
			return false;
		},
		refresh(): void {
			_clearMountCache();
			rebuild();
		},
		list(): string[] {
			return [...hazards];
		},
	};

	rebuild();
	return pruner;
}

/**
 * True when rootDir itself sits on a hazardous filesystem or when any
 * ancestor mount point of rootDir is hazardous.
 * Drives the polling decision in the watcher pool and --no-mmap in rg-search.
 */
export function rootIsHazardMount(rootDir: string): boolean {
	const resolved = rootDir.endsWith("/") ? rootDir.slice(0, -1) : rootDir;
	// Collect hazardous mount points that are equal to or ancestors of rootDir.
	let best: string | null = null;
	for (const e of readMountTable()) {
		if (!isHazardFsType(e.fsType)) continue;
		if (resolved === e.mountPoint) return true; // exact match
		// Is mountPoint a segment-ancestor of resolved?
		const mpWithSlash = e.mountPoint.endsWith("/") ? e.mountPoint : e.mountPoint + "/";
		if (resolved.startsWith(mpWithSlash)) {
			// Prefer the longest (most specific) match.
			if (!best || e.mountPoint.length > best.length) {
				best = e.mountPoint;
			}
		}
	}
	return best !== null;
}
