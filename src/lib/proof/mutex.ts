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
