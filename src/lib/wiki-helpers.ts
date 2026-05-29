import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Returns true if `<wikiDir>/<relPath>/index.html` exists and is a regular file.
 * Used server-side to classify a directory as a self-contained app folder.
 */
export async function isAppFolder(
	wikiDir: string,
	relPath: string,
): Promise<boolean> {
	try {
		const indexHtml = path.join(wikiDir, relPath, "index.html");
		const info = await stat(indexHtml);
		return info.isFile();
	} catch {
		return false;
	}
}
