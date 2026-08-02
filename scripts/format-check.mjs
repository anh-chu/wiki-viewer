#!/usr/bin/env node
/**
 * `pnpm format:check` wrapper.
 *
 * The formatter is currently disabled in biome.json to avoid churn while the
 * lint contract beds in. This script is honest about that: when the formatter
 * is disabled, it prints a notice and exits 0. Once the formatter is enabled,
 * the same script delegates to `biome format .`.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const biomeConfig = new URL("../biome.json", import.meta.url);
const cfg = JSON.parse(readFileSync(biomeConfig, "utf8"));

if (cfg.formatter?.enabled === false) {
	console.log("format:check: formatter is disabled in biome.json — skipping.");
	process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "biome", "format", "."], {
	stdio: "inherit",
	shell: false,
});
process.exit(result.status ?? 1);
