import { cp, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const destination = path.join(root, "public", "excalidraw-assets", "fonts");

try {
	await access(source);
} catch {
	console.error(`Excalidraw font assets missing: ${source}. Run pnpm install first.`);
	process.exitCode = 1;
}

if (!process.exitCode) {
	await mkdir(destination, { recursive: true });
	await cp(source, destination, { recursive: true, force: true });
	console.log(`Copied Excalidraw font assets to ${path.relative(root, destination)}`);
}
