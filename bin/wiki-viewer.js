#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const serverJs = path.join(appRoot, ".next", "standalone", "server.js");

function printUsage() {
  console.error("Usage: wiki-viewer [directory] [options]");
  console.error("");
  console.error("  directory            Directory to serve (optional — pick in browser if omitted)");
  console.error("");
  console.error("Options:");
  console.error("  -p, --port <port>   Port to listen on (default: 3000)");
  console.error("  -H, --host <host>   Host to bind to (default: localhost)");
  console.error("");
  console.error("Examples:");
  console.error("  wiki-viewer ~/notes");
  console.error("  wiki-viewer               # opens dir picker in browser");
  console.error("  wiki-viewer ~/notes -p 8080 -H 0.0.0.0");
}

if (!existsSync(serverJs)) {
  console.error("Error: pre-built server not found at", serverJs);
  console.error("This is a bug – please report it at https://github.com/anh-chu/wiki-viewer/issues");
  process.exit(1);
}

// Parse args: wiki-viewer [dir] [-p port] [-H host]
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const rootDir = args.find((a) => !a.startsWith("-"));

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

const resolvedRoot = rootDir ? path.resolve(rootDir) : null;

if (resolvedRoot) {
  console.log(`📂  ${resolvedRoot}`);
} else {
  console.log(`📂  No directory specified — open the browser to choose one`);
}
console.log(`🌐  http://${host}:${port}`);

const child = spawn(process.execPath, [serverJs], {
  cwd: path.join(appRoot, ".next", "standalone"),
  stdio: "inherit",
  env: {
    ...process.env,
    ...(resolvedRoot ? { ROOT_DIR: resolvedRoot } : {}),
    PORT: port,
    HOSTNAME: host,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
