#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const serverJs = resolve(__dirname, "..", ".next", "standalone", "server.js");

try {
	statSync(serverJs);
} catch {
	console.error("wiki-viewer-lite: .next/standalone/server.js not found. Run `npm run build` first.");
	process.exit(1);
}

/** Pick a free port on 127.0.0.1, honoring PORT env if set. */
function pickPort() {
	return new Promise((resolvePort, reject) => {
		if (process.env.PORT) {
			const p = parseInt(process.env.PORT, 10);
			if (!isNaN(p) && p > 0 && p < 65536) return resolvePort(p);
		}
		const s = createNetServer();
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolvePort(port));
		});
		s.on("error", reject);
	});
}

const MAX_RETRIES = 5;

function start(attempt) {
	if (attempt > MAX_RETRIES) {
		console.error("wiki-viewer-lite: too many EADDRINUSE retries, giving up.");
		process.exit(1);
	}

	pickPort().then((port) => {
		const prefix = process.env.WIKI_LITE_PREFIX ?? process.env.WIKI_URL_PREFIX ?? "";

		const env = {
			...process.env,
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			WIKI_NO_AUTH: "1",
			WIKI_ALLOW_INSECURE: "1",
			WIKI_LITE: "1",
			WIKI_URL_PREFIX: prefix,
			BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
		};
		delete env.ROOT_DIR;

		const child = spawn(process.execPath, [serverJs], {
			cwd: resolve(__dirname, "..", ".next", "standalone"),
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let started = false;
		let stderrBuf = "";
		let probeCount = 0;
		const MAX_PROBES = 200; // 20s at 100ms
		let probeTimer = null;

		const doProbe = () => {
			if (started) return;
			probeCount++;
			if (probeCount >= MAX_PROBES) {
				if (probeTimer) clearInterval(probeTimer);
				console.error("wiki-viewer-lite: timed out waiting for server to start");
				child.kill();
				process.exit(1);
				return;
			}
			const req = httpRequest(
				`http://127.0.0.1:${port}/api/wiki`,
				(res) => {
					res.resume();
					if (started) return;
					started = true;
					if (probeTimer) clearInterval(probeTimer);
					console.log(`WIKI_LITE_PORT=${port}`);
					if (child.stdout) child.stdout.pipe(process.stdout);
					if (child.stderr) child.stderr.pipe(process.stderr);
				},
			);
			req.on("error", () => {
				// Connection refused — server not ready yet, keep probing
			});
			req.setTimeout(500, () => {
				req.destroy();
			});
			req.end();
		};

		probeTimer = setInterval(doProbe, 100);
		doProbe(); // immediate first probe

		child.stderr.on("data", (chunk) => {
			if (!started) {
				stderrBuf += chunk.toString();
			}
		});

		child.on("error", (err) => {
			if (!started) {
				clearInterval(probeTimer);
				console.error("wiki-viewer-lite: failed to start server:", err.message);
				process.exit(1);
			}
		});

		child.on("exit", (code, signal) => {
			if (probeTimer) clearInterval(probeTimer);
			if (!started) {
				if (stderrBuf.includes("EADDRINUSE")) {
					console.error(`wiki-viewer-lite: port ${port} in use, retrying...`);
					start(attempt + 1);
					return;
				}
				console.error("wiki-viewer-lite: server exited before probe succeeded");
				process.stderr.write(stderrBuf);
				process.exit(code ?? 1);
				return;
			}
			process.exit(code ?? 0);
		});

		// Forward signals to child, then let process exit naturally.
		const onSignal = (sig) => {
			child.kill(sig);
		};
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);

		// Tear down on stdin end (daemon supervisor closes stdin to shut down).
		// When stdin is /dev/null, resume() triggers an immediate 'end' — guard
		// against that by only acting on 'end' after the first probe succeeds.
		process.stdin.on("end", () => {
			if (started) child.kill();
		});
		process.stdin.resume();
	}).catch((err) => {
		console.error("wiki-viewer-lite:", err);
		process.exit(1);
	});
}

start(1);
