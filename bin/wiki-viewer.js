#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function printUsage() {
  console.error("Usage: wiki-viewer <directory> [options]");
  console.error("");
  console.error("Options:");
  console.error("  -p, --port <port>   Port to listen on (default: 3000)");
  console.error("  -H, --host <host>   Host to bind to (default: localhost)");
  console.error("  --dev               Run in dev mode");
  console.error("");
  console.error("Examples:");
  console.error("  wiki-viewer ~/notes");
  console.error("  wiki-viewer ~/notes -p 8080");
  console.error("  wiki-viewer ~/notes -p 8080 -H 0.0.0.0");
}

// Parse args: wiki-viewer <dir> [-p port] [-H host] [--dev]
const args = process.argv.slice(2);
const rootDir = args.find((a) => !a.startsWith("-"));

if (!rootDir) {
  printUsage();
  process.exit(1);
}

let port = process.env.PORT ?? "3000";
let host = process.env.HOST ?? "localhost";
let dev = process.env.NODE_ENV === "development";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-p" || a === "--port") {
    port = args[++i] ?? port;
  } else if (a === "-H" || a === "--host") {
    host = args[++i] ?? host;
  } else if (a === "--dev") {
    dev = true;
  }
}

const resolvedRoot = path.resolve(rootDir);

console.log(`📁  ${resolvedRoot}`);
console.log(`🌐  http://${host}:${port}`);

const nextBin = path.join(appRoot, "node_modules", ".bin", "next");
const mode = dev ? "dev" : "start";
const nextArgs = [mode, "-p", port, "-H", host];

const child = spawn(nextBin, nextArgs, {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ROOT_DIR: resolvedRoot,
    PORT: port,
    HOST: host,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
