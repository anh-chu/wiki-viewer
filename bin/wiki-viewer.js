#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start, resolveServeOptions, resolveRunOptions } from "./cli/serve.js";
import {
	serviceInstall,
	serviceUninstall,
	serviceStatus,
	serviceLogs,
	serviceRestart,
} from "./cli/service.js";
import { configCommand } from "./cli/config.js";
import { update } from "./cli/update.js";
import { runWizard } from "./cli/wizard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function printUsage() {
	console.error("Usage: wiki-viewer [directory] [options]");
	console.error("       wiki-viewer <command> [args]");
	console.error("");
	console.error("  directory            Directory to serve (optional — pick in browser if omitted).");
	console.error("                       May also be an SSH target (user@host:/path) — mounted via");
	console.error("                       sshfs and served live, no local clone.");
	console.error("");
	console.error("Options:");
	console.error("  -p, --port <port>   Port to listen on (default: 3000)");
	console.error("  -H, --host <host>   Host to bind to (default: localhost)");
	console.error("  --https             Enable HTTPS (self-signed cert, enables service workers)");
	console.error("  --no-auth           Run without authentication — no sign-in, no session check");
	console.error("  --ssh-key <path>    Private key for the SSH target (default: ssh-agent / host keys)");
	console.error("  --ssh-port <port>   SSH port for the target (default: 22)");
	console.error("  --ssh-password      Prompt for an SSH password (or set WIKI_SSH_PASSWORD)");
	console.error("  --ssh-readonly      Mount the SSH target read-only");
	console.error("  -v, --version       Print version");
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
	console.error("  wiki-viewer me@server:/srv/docs");
	console.error("  wiki-viewer me@server:/srv/docs --ssh-key ~/.ssh/id_ed25519 --ssh-readonly");
	console.error("  wiki-viewer service install ~/notes -H 0.0.0.0 -p 3003 --https");
	console.error("  wiki-viewer service install ~/notes --env GOOGLE_CLIENT_ID=... --env GOOGLE_CLIENT_SECRET=...");
	console.error("  wiki-viewer config set AUTH_ALLOWED_DOMAIN=example.com");
	console.error("  wiki-viewer update");
}

async function main() {
	const argv = process.argv.slice(2);

	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		process.exit(0);
	}

	if (argv.includes("--version") || argv.includes("-v")) {
		const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
		console.log(pkg.version);
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
				case "run": await start(resolveRunOptions(subArgs)); break;
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
			await runWizard();
			break;
		case "update":
			update();
			break;
		default:
			if (argv.includes("--setup") || argv.includes("--init")) {
				await runWizard();
				break;
			}
			if (argv.length === 0 && process.stdin.isTTY) {
				console.log("Tip: run `wiki-viewer init` for guided setup (directory, host/port, HTTPS,");
				console.log("     app settings, and optional install as a reboot-persistent service).\n");
			}
			await start(resolveServeOptions(argv));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
