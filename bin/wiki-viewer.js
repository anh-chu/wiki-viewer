#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
  console.error("  --https             Enable HTTPS (self-signed cert, enables service workers)");
  console.error("");
  console.error("Examples:");
  console.error("  wiki-viewer ~/notes");
  console.error("  wiki-viewer ~/notes --https");
  console.error("  wiki-viewer ~/notes -p 8080 -H 0.0.0.0");
}

if (!existsSync(serverJs)) {
  console.error("Error: pre-built server not found at", serverJs);
  console.error("This is a bug – please report it at https://github.com/anh-chu/wiki-viewer/issues");
  process.exit(1);
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const rootDir = args.find((a) => !a.startsWith("-"));
let port = process.env.PORT ?? "3000";
let host = process.env.HOSTNAME ?? "localhost";
let useHttps = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-p" || a === "--port") port = args[++i] ?? port;
  else if (a === "-H" || a === "--host") host = args[++i] ?? host;
  else if (a === "--https") useHttps = true;
}

const resolvedRoot = rootDir ? path.resolve(rootDir) : null;

// ── HTTPS cert generation ──────────────────────────────────────────────────

function ensureCerts() {
  const dir = path.join(os.homedir(), ".wiki-viewer", "certs");
  mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }
  // Try mkcert (trusted), fall back to openssl (self-signed)
  try {
    execSync("mkcert -version", { stdio: "ignore" });
    execSync(`mkcert -install 2>/dev/null; mkcert -key-file "${keyPath}" -cert-file "${certPath}" localhost 127.0.0.1 "${host}"`, { stdio: "pipe" });
    console.log("🔒  Trusted cert via mkcert");
  } catch {
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 825 -nodes -subj "/CN=localhost"`,
        { stdio: "ignore" },
      );
      console.log("🔒  Self-signed cert (browser will warn once — click through)");
    } catch {
      console.error("Error: --https requires mkcert or openssl");
      process.exit(1);
    }
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ── free port helper ───────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
}

// ── start ──────────────────────────────────────────────────────────────────

async function start() {
  if (resolvedRoot) {
    console.log(`📂  ${resolvedRoot}`);
  } else {
    console.log("📂  No directory specified — open the browser to choose one");
  }

  // When HTTPS is requested, run the standalone server on a random internal
  // HTTP port and stand up an HTTPS reverse-proxy on the user-facing port.
  const internalPort = useHttps ? String(await freePort()) : port;
  const internalHost = "127.0.0.1";

  const child = spawn(process.execPath, [serverJs], {
    cwd: path.join(appRoot, ".next", "standalone"),
    stdio: "inherit",
    env: {
      ...process.env,
      ...(resolvedRoot ? { ROOT_DIR: resolvedRoot } : {}),
      PORT: internalPort,
      HOSTNAME: internalHost,
    },
  });

  child.on("exit", (code) => process.exit(code ?? 0));

  if (useHttps) {
    const { key, cert } = ensureCerts();

    // Simple HTTPS → HTTP proxy
    const proxy = createHttpsServer({ key, cert }, (req, res) => {
      const options = {
        hostname: internalHost,
        port: Number(internalPort),
        path: req.url,
        method: req.method,
        headers: req.headers,
      };
      const upstream = httpRequest(options, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });

    // Wait a moment for the standalone server to bind before starting proxy
    setTimeout(() => {
      proxy.listen(Number(port), host, () => {
        console.log(`🌐  https://${host}:${port}`);
      });
    }, 1_000);
  } else {
    console.log(`🌐  http://${host}:${port}`);
  }
}

start();
