#!/usr/bin/env node
/**
 * Test runner with a MINIMUM TEST COUNT FLOOR.
 *
 * Why this exists: a full run reported `fail 0` and exited 0 while two whole
 * test files produced no output at all. The run looked green. The only evidence
 * anything was wrong was the total dropping, which is invisible unless you
 * happen to remember the previous number.
 *
 * `node --test` exiting 0 does not mean the suite ran. This turns "silently ran
 * less" into a hard failure.
 *
 * Update .test-floor deliberately when adding tests; it is a floor, not an
 * exact expectation, so it never breaks on additions.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const TEST_DIR = path.resolve(import.meta.dirname, "..", "src", "tests", "proof");
const FLOOR_FILE = path.resolve(import.meta.dirname, "..", ".test-floor");

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help")) {
	console.log(`Usage: node scripts/test-floor.mjs [options] [files...]

Options:
  --update-floor    Write the current test count to .test-floor and exit 0.
  --help            Show this message and exit 0.

Without files, every *.test.ts under src/tests/proof is run.
With files, those paths are passed through to node --test unchanged.

Environment:
  TEST_FLOOR_ENFORCE=1  Enforce the floor even when running a targeted file list.
`);
	process.exit(0);
}

const updateFloor = rawArgs.includes("--update-floor");
let userFiles = rawArgs.filter((a) => a !== "--update-floor");
// pnpm test -- <args> forwards a literal `--` before the user args; strip it
// so that flags and file paths reach node --test cleanly.
if (userFiles[0] === "--") {
	userFiles.shift();
}

let testFiles;
if (userFiles.length > 0) {
	testFiles = userFiles;
} else {
	// Enumerate tests explicitly so we can spawn the runner without a shell.
	testFiles = readdirSync(TEST_DIR)
		.filter((f) => f.endsWith(".test.ts") && statSync(path.join(TEST_DIR, f)).isFile())
		.sort()
		.map((f) => path.join("src", "tests", "proof", f));
}

const args = ["--import", "./src/tests/proof/preload.ts", "--test", ...testFiles];

// Resolve tsx explicitly rather than relying on PATH: this script is also run
// directly (not just via pnpm, which injects node_modules/.bin).
const TSX = path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

let out = "";

function flushSummary() {
	// node:test's reporter prints "\u2139 tests N" on a TTY (spec reporter) and
	// "# tests N" otherwise (plain TAP, e.g. in CI without a TTY). Accept both.
	const m = out.match(/^(?:\u2139|#) tests (\d+)$/m);
	const pass = out.match(/^(?:\u2139|#) pass (\d+)$/m);
	return { total: m ? Number(m[1]) : null, passCount: pass ? Number(pass[1]) : null };
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const child = spawn(TSX, args, { cwd: repoRoot, stdio: ["inherit", "pipe", "pipe"] });

for (const stream of [child.stdout, child.stderr]) {
	stream.on("data", (b) => {
		const s = String(b);
		out += s;
		process.stdout.write(s);
	});
}

child.on("error", (err) => {
	console.error(`\n[test-floor] FAIL: failed to spawn test runner: ${err.message}`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`\n[test-floor] FAIL: test runner killed by ${signal}`);
		process.exit(1);
	}
	if (code !== 0) process.exit(code ?? 1);

	// Only enforce the floor on a full-suite run; a targeted file run is fine.
	// TEST_FLOOR_ENFORCE=1 forces enforcement on a targeted run, which is how the
	// guard itself gets tested without paying for a full suite.
	const targeted = userFiles.length > 0 && process.env.TEST_FLOOR_ENFORCE !== "1";

	const { total, passCount } = flushSummary();

	if (!targeted && total === null) {
		console.error(
			"\n[test-floor] FAIL: no test summary found. The runner produced no " +
				"`ℹ tests N` line, so the suite did not complete — regardless of exit code.",
		);
		process.exit(1);
	}

	if (targeted) process.exit(0);

	if (updateFloor) {
		writeFileSync(FLOOR_FILE, `${total}\n`);
		console.log(`[test-floor] floor updated to ${total}`);
		process.exit(0);
	}

	if (!existsSync(FLOOR_FILE)) {
		console.error(
			`\n[test-floor] FAIL: ${path.basename(FLOOR_FILE)} does not exist. ` +
				"Re-run with --update-floor to initialise it.",
		);
		process.exit(1);
	}

	const floor = Number(readFileSync(FLOOR_FILE, "utf8").trim());
	if (Number.isFinite(floor) && total < floor) {
		console.error(
			`\n[test-floor] FAIL: ran ${total} tests but the floor is ${floor}. ` +
				`${floor - total} test(s) did not run.\n` +
				"This is the silent-skip failure: `fail 0` and exit 0 while whole files " +
				"produced no output. Re-run on an idle machine; if the drop is intentional, " +
				"run `pnpm test -- --update-floor`.",
		);
		process.exit(1);
	}

	console.log(
		`[test-floor] OK: ${passCount ?? total} passed, ran ${total}${Number.isFinite(floor) ? `, floor ${floor}` : ""}`,
	);
	process.exit(0);
});
