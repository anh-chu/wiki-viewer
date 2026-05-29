#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const serverJs = path.join(appRoot, ".next", "standalone", "server.js");

function printUsage() {
  console.error("Usage: wiki-viewer <directory> [options]");
  console.error("");
  console.error("Options:");
  console.error("  -p, --port <port>   Port to listen on (default: 3000)");
  console.error("  -H, --host <host>   Host to bind to (default: localhost)");
  console.error("");
  console.error("Examples:");
  console.error("  wiki-viewer ~/notes");
  console.error("  wiki-viewer ~/notes -p 8080");
  console.error("  wiki-viewer ~/notes -p 8080 -H 0.0.0.0");
}

if (!existsSync(serverJs)) {
  console.error("Error: pre-built server not found at", serverJs);
  console.error("This is a bug – please report it at https://github.com/anh-chu/wiki-viewer/issues");
  process.exit(1);
}

// Parse args: wiki-viewer <dir> [-p port] [-H host]
const args = process.argv.slice(2);
const rootDir = args.find((a) => !a.startsWith("-"));

if (!rootDir) {
  printUsage();
  process.exit(1);
}

let port = process.env.PORT ?? "3000";
let host = process.env.HOSTNAME ?? "localhost";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-p" || a === "--port") {
    port = args[++i] ?? port;
  } else if (a === "-H" || a === "--host") {
    host = args[++i] ?? host;
  }
}

const resolvedRoot = path.resolve(rootDir);

console.log(`📂  ${resolvedRoot}`);
console.log(`🌐  http://${host}:${port}`);

// The standalone server.js reads PORT and HOSTNAME from env
const child = spawn(process.execPath, [serverJs], {
  cwd: path.join(appRoot, ".next", "standalone"),
  stdio: "inherit",
  env: {
    ...process.env,
    ROOT_DIR: resolvedRoot,
    PORT: port,
    HOSTNAME: host,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
