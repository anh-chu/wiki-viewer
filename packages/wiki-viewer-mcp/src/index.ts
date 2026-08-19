#!/usr/bin/env node
/**
 * wiki-viewer-mcp — MCP filesystem adapter for wiki-viewer agent API.
 *
 * Thin executable entry point. Re-exports the server/client factories for tests,
 * routes CLI invocations to `runCli()`, and loads the server version from the
 * package metadata instead of hardcoding it.
 */

import { fileURLToPath } from "node:url";

export { createServer } from "./server.js";
export { createClient } from "./cli.js";
export type { CreateServerOptions } from "./server.js";

import { runCli } from "./cli.js";

const __filename = fileURLToPath(import.meta.url);
const invokedAsEntryPoint =
  process.argv[1] &&
  (
    process.argv[1] === __filename ||
    process.argv[1].endsWith("wiki-viewer-mcp") ||
    (process.argv[1].endsWith("index.js") && !process.argv[1].includes("__tests__"))
  );

if (invokedAsEntryPoint) {
  runCli().catch((e) => {
    console.error("wiki-viewer-mcp fatal:", e);
    process.exit(1);
  });
}
