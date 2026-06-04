// Workspacing note (Phase B): callers must prefix the lock key with rootDir
// (or wsId) to ensure two workspaces sharing the same relPath do not serialize
// against each other. e.g. key = `${rootDir}\0${relPath}`. Phase B call sites
// will make this change when route threading is done.
import { withFileLock } from "./file-lock";

const locks = new Map<string, Promise<void>>();

/**
 * Acquire an in-process mutex (for same-process serialisation) and then a
 * cross-process file lock (for multi-replica safety).
 *
 * The in-process mutex is held for the outer scope so that same-process
 * callers never race for the file lock. The file lock is acquired inside so
 * that different processes can safely share the same data files.
 */
export async function withFileMutex<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	while (locks.has(filePath)) {
		await locks.get(filePath);
	}
	let release!: () => void;
	const p = new Promise<void>((r) => {
		release = r;
	});
	locks.set(filePath, p);
	try {
		// Cross-process file lock wraps the inner fn.
		return await withFileLock(filePath, fn);
	} finally {
		locks.delete(filePath);
		release();
	}
}
