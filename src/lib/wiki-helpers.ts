import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Returns true if the directory has a package.json — treated as a runnable node app.
 * Checked before isAppFolder so package.json wins over index.html.
 */
export async function isNodeApp(
	wikiDir: string,
	relPath: string,
): Promise<boolean> {
	try {
		const pkgJson = path.join(wikiDir, relPath, "package.json");
		const info = await stat(pkgJson);
		return info.isFile();
	} catch {
		return false;
	}
}

/**
 * Returns true if `<wikiDir>/<relPath>/index.html` exists and is a regular file.
 * Used server-side to classify a directory as a self-contained static app folder.
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
