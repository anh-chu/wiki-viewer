#!/usr/bin/env node
/**
 * Test runner with a MINIMUM TEST COUNT FLOOR.
 *
 * Why this exists: a full run reported `fail 0` and exited 0 while two whole
 * test files (demand-search.test.ts, watcher-pool.test.ts — 88 tests) produced
 * no output at all. The run looked green. The only evidence anything was wrong
 * was the total dropping from 557 to 469, which is invisible unless you happen
 * to remember the previous number.
 *
 * `node --test` exiting 0 does not mean the suite ran. This turns "silently ran
 * less" into a hard failure.
 *
 * Update .test-floor deliberately when adding tests; it is a floor, not an
 * exact expectation, so it never breaks on additions.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const FLOOR_FILE = path.join(import.meta.dirname, "..", ".test-floor");

const args = [
	"--import",
	"./src/tests/proof/preload.ts",
	"--test",
	...(process.argv.slice(2).length
		? process.argv.slice(2)
		: ["src/tests/proof/*.test.ts"]),
];

// Resolve tsx explicitly rather than relying on PATH: this script is also run
// directly (not just via pnpm, which injects node_modules/.bin).
const TSX = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

// Shell needed for the glob; keep it explicit so the expansion is obvious.
const child = spawn(
	`${TSX} ${args.map((a) => (a.includes("*") ? `'${a}'` : a)).join(" ")}`,
	{ shell: true, stdio: ["inherit", "pipe", "pipe"] },
);

let out = "";
for (const stream of [child.stdout, child.stderr]) {
	stream.on("data", (b) => {
		const s = String(b);
		out += s;
		process.stdout.write(s);
	});
}

child.on("exit", (code) => {
	// Only enforce the floor on a full-suite run; a targeted file run is fine.
	// TEST_FLOOR_ENFORCE=1 forces enforcement on a targeted run, which is how the
	// guard itself gets tested without paying for a full suite.
	const targeted =
		process.argv.slice(2).length > 0 && process.env.TEST_FLOOR_ENFORCE !== "1";

	const m = out.match(/^\u2139 tests (\d+)$/m);
	const pass = out.match(/^\u2139 pass (\d+)$/m);
	const total = m ? Number(m[1]) : null;

	if (!targeted && total === null) {
		console.error(
			"\n[test-floor] FAIL: no test summary found. The runner produced no " +
				"`\u2139 tests N` line, so the suite did not complete — regardless of exit code.",
		);
		process.exit(1);
	}

	if (code !== 0) process.exit(code ?? 1);
	if (targeted) process.exit(0);

	if (!existsSync(FLOOR_FILE)) {
		writeFileSync(FLOOR_FILE, `${total}\n`);
		console.log(`[test-floor] initialised floor at ${total}`);
		process.exit(0);
	}

	const floor = Number(readFileSync(FLOOR_FILE, "utf8").trim());
	if (Number.isFinite(floor) && total < floor) {
		console.error(
			`\n[test-floor] FAIL: ran ${total} tests but the floor is ${floor}. ` +
				`${floor - total} test(s) did not run.\n` +
				"This is the silent-skip failure: `fail 0` and exit 0 while whole files " +
				"produced no output. Re-run on an idle machine; if the drop is intentional, " +
				`lower .test-floor deliberately.`,
		);
		process.exit(1);
	}

	if (total > floor) {
		writeFileSync(FLOOR_FILE, `${total}\n`);
		console.log(`[test-floor] floor raised ${floor} \u2192 ${total}`);
	}
	console.log(`[test-floor] OK: ${pass ? pass[1] : total} passed, floor ${total}`);
	process.exit(0);
});
