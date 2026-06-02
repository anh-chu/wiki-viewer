#!/usr/bin/env node
import { spawn, execSync, execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const serverJs = path.join(appRoot, ".next", "standalone", "server.js");
const selfScript = fileURLToPath(import.meta.url);

const configDir = path.join(os.homedir(), ".wiki-viewer");
const configPath = path.join(configDir, "config.json");
const logDir = path.join(configDir, "logs");

const SERVICE_NAME = "wiki-viewer";
const LAUNCHD_LABEL = "com.wiki-viewer";

function printUsage() {
  console.error("Usage: wiki-viewer [directory] [options]");
  console.error("       wiki-viewer <command> [args]");
  console.error("");
  console.error("  directory            Directory to serve (optional — pick in browser if omitted)");
  console.error("");
  console.error("Options:");
  console.error("  -p, --port <port>   Port to listen on (default: 3000)");
  console.error("  -H, --host <host>   Host to bind to (default: localhost)");
  console.error("  --https             Enable HTTPS (self-signed cert, enables service workers)");
  console.error("");
  console.error("  -e, --env <KEY=VALUE>  Set an app env var (repeatable; persisted with service install)");
  console.error("");
  console.error("Commands:");
  console.error("  init                              Interactive setup wizard (dir, host/port, https, env, service)");
  console.error("  service install [dir] [options]   Install as a user service (persists across reboot)");
  console.error("  service uninstall                 Remove the user service");
  console.error("  service status                    Show service status");
  console.error("  service logs                      Tail service logs");
  console.error("  service restart                   Restart the service");
  console.error("  service run                       Run from saved config (used internally by the service)");
  console.error("  config show                       Print the saved config");
  console.error("  config set KEY=VALUE              Set an app env var in the config");
  console.error("  config unset KEY                  Remove an app env var from the config");
  console.error("  update                            Update wiki-viewer to the latest version and restart");
  console.error("");
  console.error("Examples:");
  console.error("  wiki-viewer init");
  console.error("  wiki-viewer ~/notes");
  console.error("  wiki-viewer ~/notes --https");
  console.error("  wiki-viewer ~/notes -p 8080 -H 0.0.0.0");
  console.error("  wiki-viewer service install ~/notes -H 0.0.0.0 -p 3003 --https");
  console.error("  wiki-viewer service install ~/notes --env GOOGLE_CLIENT_ID=... --env GOOGLE_CLIENT_SECRET=...");
  console.error("  wiki-viewer config set AUTH_ALLOWED_DOMAIN=example.com");
  console.error("  wiki-viewer update");
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseServeArgs(args) {
  let port = process.env.PORT;
  let host = process.env.HOSTNAME;
  let useHttps;
  let userSpecifiedPort = false;
  let rootDir;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--port") { port = args[++i] ?? port; userSpecifiedPort = true; }
    else if (a === "-H" || a === "--host") host = args[++i] ?? host;
    else if (a === "-e" || a === "--env") { i++; } // consumed by parseEnvFlags
    else if (a === "--https") useHttps = true;
    else if (!a.startsWith("-") && rootDir === undefined) rootDir = a;
  }

  return { rootDir, port, host, useHttps, userSpecifiedPort };
}

// ── config file ────────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    console.error(`Warning: could not parse ${configPath}, ignoring it`);
    return {};
  }
}

function saveConfig(cfg) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

// Ad-hoc serve: CLI flags + built-in defaults. The run *shape* (dir/host/port)
// does NOT read the config file, so an installed service never silently alters
// a one-off invocation. App-level env (config.env) is still read, because those
// are settings about the app itself (allowlists, OAuth) rather than the bind.
function resolveServeOptions(args) {
  const cli = parseServeArgs(args);
  const cfg = loadConfig();
  return {
    rootDir: cli.rootDir ? path.resolve(cli.rootDir) : null,
    port: String(cli.port ?? "3000"),
    host: cli.host ?? "localhost",
    useHttps: Boolean(cli.useHttps),
    userSpecifiedPort: cli.userSpecifiedPort,
    // App env: config.env as base, ad-hoc --env flags override per run.
    configEnv: { ...(cfg.env ?? {}), ...parseEnvFlags(args) },
  };
}

// Service run: config file is the source of truth. CLI flags (if any) still win
// so the unit/plist could pass overrides, but normally there are none.
// Precedence: explicit CLI flags > config file > built-in defaults.
function resolveRunOptions(args) {
  const cli = parseServeArgs(args);
  const cfg = loadConfig();

  const rootDir = cli.rootDir ?? cfg.rootDir ?? null;
  const port = cli.port ?? cfg.port ?? "3000";
  const host = cli.host ?? cfg.host ?? "localhost";
  const useHttps = cli.useHttps ?? cfg.https ?? false;
  // A config-pinned port is explicit too (don't auto-bump to next free port).
  const userSpecifiedPort = cli.userSpecifiedPort || cfg.port != null;

  return {
    rootDir: rootDir ? path.resolve(rootDir) : null,
    port: String(port),
    host,
    useHttps: Boolean(useHttps),
    userSpecifiedPort,
    configEnv: { ...(cfg.env ?? {}), ...parseEnvFlags(args) },
  };
}

// ── environment resolution ───────────────────────────────────────────────────

// Env vars the app reads that the bin can derive or manage on the user's behalf.
// Everything else in config.env is passed through verbatim.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

function isLocalHost(h) {
  return LOCAL_HOSTS.has(h);
}

// Build the env for the spawned server.
// Precedence (highest first):
//   1. the shell environment the user launched us with (explicit override)
//   2. config.env from ~/.wiki-viewer/config.json
//   3. values derived by the bin from the run options (e.g. BETTER_AUTH_URL)
//
// Returns { env, warnings } where warnings are human-readable strings to print
// before the server starts.
function computeServerEnv({ host, port, useHttps, configEnv }) {
  const warnings = [];
  const derived = {};

  const scheme = useHttps ? "https" : "http";
  const urlHost = isLocalHost(host) || host === "0.0.0.0" ? "localhost" : host;
  const isSecureContext = useHttps || isLocalHost(host);

  // BETTER_AUTH_URL: the app requires this in production so cookies and OAuth
  // callbacks resolve. Derive it from the bind so the common case needs no
  // config at all.
  derived.BETTER_AUTH_URL = `${scheme}://${urlHost}:${port}`;

  // The app refuses to boot in production over an insecure context unless
  // WIKI_ALLOW_INSECURE=1. localhost http is fine (browsers treat it as secure).
  // Remote http is not: auth cookies and service workers will silently break.
  if (!isSecureContext) {
    derived.WIKI_ALLOW_INSECURE = "1";
    warnings.push(
      `Serving plain HTTP on a non-local host (${host}). Browsers treat this as\n` +
      `   an insecure context: login cookies, service workers and PDF.js will not\n` +
      `   work reliably, and OAuth callbacks will fail.\n` +
      `   Fix: re-run with --https, or put a TLS-terminating proxy in front and set\n` +
      `   BETTER_AUTH_URL to its public https:// URL (see "env" in ${configPath}).`,
    );
  } else if (isLocalHost(host) && !useHttps) {
    // localhost http is a secure context for the browser, but the app's prod
    // guard still wants the bypass flag set explicitly. Do it for the user.
    derived.WIKI_ALLOW_INSECURE = "1";
  }

  // Layer: derived < config.env < shell env.
  const env = { ...derived, ...configEnv };

  // Note when the shell or config overrode a derived value so the user isn't
  // surprised that --host/--port didn't change the auth URL.
  if (configEnv.BETTER_AUTH_URL && configEnv.BETTER_AUTH_URL !== derived.BETTER_AUTH_URL) {
    // config wins over derived; that's intentional, no warning needed.
  }
  if (process.env.BETTER_AUTH_URL && process.env.BETTER_AUTH_URL !== env.BETTER_AUTH_URL) {
    warnings.push(
      `BETTER_AUTH_URL is set in your shell (${process.env.BETTER_AUTH_URL}) and\n` +
      `   overrides the derived/config value.`,
    );
  }

  return { env, warnings };
}

// ── HTTPS cert generation ──────────────────────────────────────────────────

function ensureCerts(host) {
  const dir = path.join(configDir, "certs");
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
    console.log("��  Trusted cert via mkcert");
  } catch {
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 825 -nodes -subj "/CN=localhost"`,
        { stdio: "ignore" },
      );
      console.log("��  Self-signed cert (browser will warn once — click through)");
    } catch {
      console.error("Error: --https requires mkcert or openssl");
      process.exit(1);
    }
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ── port availability helpers ──────────────────────────────────────────────

function isPortAvailable(p, h) {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(Number(p), h);
  });
}

async function findNextAvailablePort(startPort, h) {
  let p = Number(startPort);
  while (!(await isPortAvailable(p, h))) p++;
  return String(p);
}

function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
}

function getNetworkAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

// ── start ──────────────────────────────────────────────────────────────────

async function start(opts) {
  const { rootDir: resolvedRoot, useHttps, configEnv = {} } = opts;
  let { port, host, userSpecifiedPort } = opts;

  if (!existsSync(serverJs)) {
    console.error("Error: pre-built server not found at", serverJs);
    console.error("This is a bug – please report it at https://github.com/anh-chu/wiki-viewer/issues");
    process.exit(1);
  }

  if (resolvedRoot) {
    console.log(`��  ${resolvedRoot}`);
  } else {
    console.log("��  No directory specified — open the browser to choose one");
  }

  // Auto-select next free port when user didn't specify one
  if (!userSpecifiedPort) {
    const available = await isPortAvailable(Number(port), host);
    if (!available) {
      const original = port;
      port = await findNextAvailablePort(Number(port) + 1, host);
      console.log(`⚠️   Port ${original} in use → using ${port} (pass -p <port> to override)`);
    }
  }

  // When HTTPS is requested, run the standalone server on a random internal
  // HTTP port and stand up an HTTPS reverse-proxy on the user-facing port.
  const internalPort = useHttps ? String(await freePort()) : port;
  // In HTTPS mode the standalone server sits behind the proxy on loopback.
  // Otherwise it must bind to the user-requested host directly.
  const internalHost = useHttps ? "127.0.0.1" : host;

  // Resolve the app environment (config.env + shell overrides + derived
  // BETTER_AUTH_URL etc.) against the user-facing host/port, then print any
  // guidance before the server boots.
  const { env: appEnv, warnings } = computeServerEnv({ host, port, useHttps, configEnv });
  for (const w of warnings) console.log(`\n⚠️   ${w}`);

  const child = spawn(process.execPath, [serverJs], {
    cwd: path.join(appRoot, ".next", "standalone"),
    stdio: "inherit",
    env: {
      ...appEnv,         // derived defaults + config.env
      ...process.env,    // shell env always wins over derived/config
      ...(resolvedRoot ? { ROOT_DIR: resolvedRoot } : {}),
      PORT: internalPort,
      HOSTNAME: internalHost,
    },
  });

  child.on("exit", (code) => process.exit(code ?? 0));

  if (useHttps) {
    const { key, cert } = ensureCerts(host);

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
        const scheme = "https";
        const displayHost = host === "0.0.0.0" ? "localhost" : host;
        console.log(`\n  ➜  Local:   ${scheme}://${displayHost}:${port}`);
        const netAddr = getNetworkAddress();
        if (netAddr && host !== "localhost" && host !== "127.0.0.1") {
          console.log(`  ➜  Network: ${scheme}://${netAddr}:${port}`);
        }
        console.log(`\n  Listening on ${host}:${port}  (--host / -H, --port / -p to rebind)\n`);
      });
    }, 1_000);
  } else {
    const scheme = "http";
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`\n  ➜  Local:   ${scheme}://${displayHost}:${port}`);
    const netAddr = getNetworkAddress();
    if (netAddr && host !== "localhost" && host !== "127.0.0.1") {
      console.log(`  ➜  Network: ${scheme}://${netAddr}:${port}`);
    }
    console.log(`\n  Listening on ${host}:${port}  (--host / -H, --port / -p to rebind)\n`);
  }
}

// ── service: shared ──────────────────────────────────────────────────────────

function platform() {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  return null;
}

function requireSupportedPlatform() {
  const p = platform();
  if (!p) {
    console.error(`Error: service management is only supported on Linux (systemd) and macOS (launchd), not ${process.platform}.`);
    process.exit(1);
  }
  return p;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function runQuiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    return null;
  }
}

// ── service: install ──────────────────────────────────────────────────────────

// Pull repeatable `--env KEY=VALUE` (or `-e KEY=VALUE`) pairs out of an argv
// list. Returns the collected map; the caller has already parsed the rest.
function parseEnvFlags(args) {
  const env = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" || args[i] === "-e") {
      const pair = args[++i];
      if (!pair || !pair.includes("=")) {
        console.error(`Error: --env expects KEY=VALUE (got: ${pair ?? "(nothing)"})`);
        process.exit(1);
      }
      const idx = pair.indexOf("=");
      env[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }
  return env;
}

function serviceInstall(args) {
  const p = requireSupportedPlatform();

  // Capture the run config from flags (falling back to existing config), persist it.
  const cli = parseServeArgs(args);
  const envFlags = parseEnvFlags(args);
  const existing = loadConfig();
  const mergedEnv = { ...(existing.env ?? {}), ...envFlags };
  const cfg = {
    rootDir: cli.rootDir != null ? path.resolve(cli.rootDir) : existing.rootDir ?? null,
    host: cli.host ?? existing.host ?? "localhost",
    port: cli.port ?? existing.port ?? "3000",
    https: cli.useHttps ?? existing.https ?? false,
    ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}),
  };
  saveConfig(cfg);
  console.log(`Saved config to ${configPath}`);
  console.log(`  dir:   ${cfg.rootDir ?? "(choose in browser)"}`);
  console.log(`  host:  ${cfg.host}`);
  console.log(`  port:  ${cfg.port}`);
  console.log(`  https: ${cfg.https}`);
  if (cfg.env) {
    console.log(`  env:   ${Object.keys(cfg.env).join(", ")}`);
  }
  console.log("");

  // Surface the same secure-context guidance the server would, at install time.
  const { warnings } = computeServerEnv({
    host: cfg.host, port: String(cfg.port), useHttps: Boolean(cfg.https), configEnv: cfg.env ?? {},
  });
  for (const w of warnings) console.log(`⚠️   ${w}\n`);

  if (p === "linux") installSystemd();
  else installLaunchd();
}

// `wiki-viewer config` — show or edit the saved config (incl. env).
function configCommand(args) {
  const cfg = loadConfig();

  if (args.length === 0 || args[0] === "show" || args[0] === "list") {
    if (!existsSync(configPath)) {
      console.log(`No config yet at ${configPath}`);
      console.log(`Create one with: wiki-viewer service install [dir] [options] [--env KEY=VALUE]`);
      return;
    }
    console.log(configPath);
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (args[0] === "set") {
    const pairs = args.slice(1);
    if (pairs.length === 0) {
      console.error("Usage: wiki-viewer config set KEY=VALUE [KEY=VALUE ...]");
      process.exit(1);
    }
    cfg.env = cfg.env ?? {};
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx < 0) { console.error(`Error: expected KEY=VALUE (got: ${pair})`); process.exit(1); }
      cfg.env[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    saveConfig(cfg);
    console.log(`Updated env in ${configPath}: ${pairs.map((p) => p.split("=")[0]).join(", ")}`);
    if (serviceIsInstalled()) console.log("Run `wiki-viewer service restart` to apply.");
    return;
  }

  if (args[0] === "unset") {
    const keys = args.slice(1);
    if (keys.length === 0) { console.error("Usage: wiki-viewer config unset KEY [KEY ...]"); process.exit(1); }
    cfg.env = cfg.env ?? {};
    for (const k of keys) delete cfg.env[k];
    saveConfig(cfg);
    console.log(`Removed from env: ${keys.join(", ")}`);
    if (serviceIsInstalled()) console.log("Run `wiki-viewer service restart` to apply.");
    return;
  }

  if (args[0] === "path") { console.log(configPath); return; }

  console.error(`Unknown config command: ${args[0]}`);
  console.error("Try: show | set KEY=VALUE | unset KEY | path");
  process.exit(1);
}

function installSystemd() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, `${SERVICE_NAME}.service`);

  const unit = `[Unit]
Description=wiki-viewer local file viewer
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${selfScript} service run
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit);
  console.log(`Wrote unit ${unitPath}`);

  // Enable lingering so the service survives logout and starts at boot.
  const user = os.userInfo().username;
  try {
    execFileSync("loginctl", ["enable-linger", user], { stdio: "ignore" });
    console.log(`Enabled linger for ${user} (starts at boot)`);
  } catch {
    console.log(`Note: could not enable linger automatically. For boot persistence run:`);
    console.log(`  sudo loginctl enable-linger ${user}`);
  }

  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
  console.log("\nService installed and started.");
  console.log("  Status: wiki-viewer service status");
  console.log("  Logs:   wiki-viewer service logs");
}

function installLaunchd() {
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const plistPath = path.join(agentsDir, `${LAUNCHD_LABEL}.plist`);
  const outLog = path.join(logDir, "out.log");
  const errLog = path.join(logDir, "err.log");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${selfScript}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);
  console.log(`Wrote plist ${plistPath}`);

  // Reload if already loaded, then load with -w to persist across reboot.
  runQuiet("launchctl", ["unload", plistPath]);
  run("launchctl", ["load", "-w", plistPath]);
  console.log("\nService installed and started.");
  console.log("  Status: wiki-viewer service status");
  console.log("  Logs:   wiki-viewer service logs");
}

// ── service: uninstall ──────────────────────────────────────────────────────

function serviceUninstall() {
  const p = requireSupportedPlatform();
  if (p === "linux") {
    runQuiet("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
    const unitPath = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
    if (existsSync(unitPath)) { rmSync(unitPath); console.log(`Removed ${unitPath}`); }
    runQuiet("systemctl", ["--user", "daemon-reload"]);
  } else {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    runQuiet("launchctl", ["unload", "-w", plistPath]);
    if (existsSync(plistPath)) { rmSync(plistPath); console.log(`Removed ${plistPath}`); }
  }
  console.log("Service uninstalled.");
}

// ── service: status / logs ──────────────────────────────────────────────────

function serviceStatus() {
  const p = requireSupportedPlatform();
  if (p === "linux") {
    try { run("systemctl", ["--user", "status", `${SERVICE_NAME}.service`, "--no-pager"]); }
    catch { /* systemctl exits non-zero when inactive; output already shown */ }
  } else {
    const out = runQuiet("launchctl", ["list"]);
    if (out) {
      const line = out.split("\n").find((l) => l.includes(LAUNCHD_LABEL));
      console.log(line ? line.trim() : `${LAUNCHD_LABEL}: not loaded`);
    }
  }
}

function serviceLogs() {
  const p = requireSupportedPlatform();
  if (p === "linux") {
    run("journalctl", ["--user", "-u", `${SERVICE_NAME}.service`, "-n", "100", "-f"]);
  } else {
    const outLog = path.join(logDir, "out.log");
    const errLog = path.join(logDir, "err.log");
    run("tail", ["-n", "100", "-f", outLog, errLog]);
  }
}

function serviceIsInstalled() {
  const p = platform();
  if (p === "linux") {
    return existsSync(path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`));
  }
  if (p === "macos") {
    return existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
  }
  return false;
}

function serviceRestart() {
  const p = platform();
  if (p === "linux") {
    run("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]);
  } else if (p === "macos") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    runQuiet("launchctl", ["unload", plistPath]);
    run("launchctl", ["load", "-w", plistPath]);
  }
}

// ── update ────────────────────────────────────────────────────────────────

function detectPackageManager() {
  // Prefer the manager whose global root contains this install.
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (selfScript.includes(`${path.sep}pnpm${path.sep}`)) return "pnpm";
  return "npm";
}

function update() {
  const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const name = pkg.name;
  console.log(`Current ${name}: v${pkg.version}`);

  const pm = detectPackageManager();
  const cmd = pm === "pnpm" ? ["pnpm", ["add", "-g", `${name}@latest`]]
            : pm === "yarn" ? ["yarn", ["global", "add", `${name}@latest`]]
            : ["npm", ["install", "-g", `${name}@latest`]];

  console.log(`Updating via ${pm}…`);
  try {
    run(cmd[0], cmd[1]);
  } catch {
    console.error(`Error: update failed. Try manually: ${cmd[0]} ${cmd[1].join(" ")}`);
    process.exit(1);
  }

  if (serviceIsInstalled()) {
    console.log("Restarting service…");
    try { serviceRestart(); console.log("Service restarted."); }
    catch { console.log("Note: could not restart service automatically. Run: wiki-viewer service restart"); }
  }
  console.log("Update complete.");
}

// ── interactive setup wizard ──────────────────────────────────────────────

// Common app env vars worth offering during setup. Anything not listed can
// still be added later with `wiki-viewer config set KEY=VALUE`.
const WIZARD_ENV_VARS = [
  { key: "AUTH_ALLOWED_DOMAIN", hint: "Restrict signup to an email domain, e.g. example.com" },
  { key: "AUTH_ALLOWED_EMAILS", hint: "Restrict signup to specific emails (comma-separated)" },
  { key: "GOOGLE_CLIENT_ID", hint: "Google OAuth client ID (enables Google sign-in)" },
  { key: "GOOGLE_CLIENT_SECRET", hint: "Google OAuth client secret" },
  { key: "AUTH_DISABLE_PASSWORD", hint: "Set to 1 to allow Google sign-in only (requires Google keys)" },
  { key: "WIKI_OWNER_HOSTS", hint: "Extra hostnames trusted for the AI panel owner cookie" },
  { key: "AGENT_RATE_LIMIT", hint: "Per-minute agent API rate limit (default 60)" },
];

// A prompt helper that survives piped (non-TTY) stdin. node:readline/promises
// closes the stream between awaited questions when input is piped, so we buffer
// every line via the 'line' event and hand them out one at a time instead.
function makePrompter() {
  const rl = createInterface({ input: stdin, output: stdout });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on("line", (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });

  const nextLine = () =>
    new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else if (closed) resolve(null);
      else waiters.push(resolve);
    });

  const prompt = async (text) => {
    stdout.write(text);
    const line = await nextLine();
    return line == null ? "" : line;
  };

  return { prompt, close: () => rl.close() };
}

async function runWizard() {
  const io = makePrompter();
  const existing = loadConfig();

  const ask = async (label, def) => {
    const suffix = def ? ` [${def}]` : "";
    const answer = (await io.prompt(`${label}${suffix}: `)).trim();
    return answer || def || "";
  };
  const askYesNo = async (label, defYes) => {
    const def = defYes ? "Y/n" : "y/N";
    const answer = (await io.prompt(`${label} [${def}]: `)).trim().toLowerCase();
    if (!answer) return defYes;
    return answer === "y" || answer === "yes";
  };

  try {
    console.log("\nwiki-viewer setup\n");
    console.log("Answer a few questions. Press Enter to accept the [default].\n");

    // 1. directory
    const dirInput = await ask(
      "Directory to serve (blank = choose later in the browser)",
      existing.rootDir ?? process.cwd(),
    );
    const rootDir = dirInput ? path.resolve(dirInput) : null;
    if (rootDir && !existsSync(rootDir)) {
      console.log(`  Note: ${rootDir} does not exist yet; it will be served once created.`);
    }

    // 2. host
    const host = await ask(
      "Host to bind (localhost for this machine only, 0.0.0.0 for the network)",
      existing.host ?? "localhost",
    );

    // 3. port
    const port = await ask("Port", String(existing.port ?? "3000"));

    // 4. https
    const httpsDefault = existing.https ?? (!isLocalHost(host) && host !== "0.0.0.0");
    const useHttps = await askYesNo(
      "Enable HTTPS? (recommended for any non-localhost access)",
      Boolean(httpsDefault),
    );

    // 5. app env vars
    const env = { ...(existing.env ?? {}) };
    const wantEnv = await askYesNo(
      "\nConfigure app settings now? (OAuth, signup allowlist, rate limit)",
      false,
    );
    if (wantEnv) {
      console.log("Leave blank to skip a setting.\n");
      for (const { key, hint } of WIZARD_ENV_VARS) {
        const cur = env[key];
        const val = await ask(`  ${key} — ${hint}`, cur);
        if (val) env[key] = val;
        else delete env[key];
      }
    }

    // Build and preview the config.
    const cfg = {
      rootDir,
      host,
      port,
      https: useHttps,
      ...(Object.keys(env).length ? { env } : {}),
    };

    console.log("\nConfiguration:");
    console.log(`  directory : ${rootDir ?? "(choose in browser)"}`);
    console.log(`  host      : ${host}`);
    console.log(`  port      : ${port}`);
    console.log(`  https     : ${useHttps}`);
    if (cfg.env) console.log(`  app env   : ${Object.keys(cfg.env).join(", ")}`);

    // Secure-context guidance before committing.
    const { warnings } = computeServerEnv({ host, port: String(port), useHttps, configEnv: cfg.env ?? {} });
    for (const w of warnings) console.log(`\n⚠️   ${w}`);

    // 6. what to do now
    console.log("");
    console.log("What next?");
    console.log("  1) Install as a service (starts now and on every reboot)");
    console.log("  2) Run once now (foreground)");
    console.log("  3) Save config only");
    const choice = (await io.prompt("Choose [1/2/3]: ")).trim() || "1";

    saveConfig(cfg);
    console.log(`\nSaved ${configPath}`);

    io.close();

    if (choice === "1") {
      const p = platform();
      if (!p) {
        console.log("Service install is only supported on Linux and macOS.");
        console.log("Run it yourself with: wiki-viewer service run");
        return;
      }
      if (p === "linux") installSystemd();
      else installLaunchd();
    } else if (choice === "2") {
      start(resolveRunOptions([]));
    } else {
      console.log("\nStart it any time with:");
      console.log("  wiki-viewer service install   # persistent service");
      console.log("  wiki-viewer service run       # run from this config");
    }
  } finally {
    // io may already be closed; closing twice is a no-op.
    io.close();
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

const [cmd, ...rest] = argv;

switch (cmd) {
  case "service": {
    const [sub, ...subArgs] = rest;
    switch (sub) {
      case "install": serviceInstall(subArgs); break;
      case "uninstall": serviceUninstall(); break;
      case "status": serviceStatus(); break;
      case "logs": serviceLogs(); break;
      case "restart": serviceRestart(); break;
      case "run": start(resolveRunOptions(subArgs)); break;
      default:
        console.error(`Unknown service command: ${sub ?? "(none)"}`);
        console.error("Try: install | uninstall | status | logs | restart | run");
        process.exit(1);
    }
    break;
  }
  case "config":
    configCommand(rest);
    break;
  case "init":
  case "setup":
    runWizard();
    break;
  case "update":
    update();
    break;
  default:
    if (argv.includes("--setup") || argv.includes("--init")) {
      runWizard();
      break;
    }
    // No recognized command → ad-hoc serve (directory + flags only).
    // On a bare interactive run, point users at the guided setup first.
    if (argv.length === 0 && stdin.isTTY) {
      console.log("Tip: run `wiki-viewer init` for guided setup (directory, host/port, HTTPS,");
      console.log("     app settings, and optional install as a reboot-persistent service).\n");
    }
    start(resolveServeOptions(argv));
}
