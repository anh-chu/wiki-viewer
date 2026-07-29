#!/usr/bin/env node
/**
 * prepare hook: make sure dist exists for a consumer that installs this package
 * from a path.
 *
 * Measured behaviour, npm 11.11.0, rather than assumed: npm DOES run `prepare` for
 * a `file:` dependency, even though it symlinks the directory rather than copying
 * it. So the fix can live here, next to the thing that needs building.
 *
 * But it does NOT install this package's own devDependencies, because the consumer
 * install only resolves the consumer's tree. A naive `prepare: "npm run build"` in
 * a fresh clone therefore fails with:
 *     npm error code 127
 *     npm error command sh -c vite build
 *     npm error sh: 1: vite: not found
 * which is loud but tells the operator nothing about what to do. This script turns
 * that into instructions.
 *
 * Three states:
 *   dist present                  no-op, so a consumer install stays fast
 *   dist missing, toolchain here  build it
 *   dist missing, no toolchain    explain exactly what to run, and fail
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist/index.js");
const toolchain = path.join(root, "node_modules/vite");

if (existsSync(entry)) {
  process.exit(0);
}

if (!existsSync(toolchain)) {
  console.error(
    [
      "",
      "@wiki-viewer/viewer has no build output, and its build toolchain is not installed.",
      "",
      "This happens on a fresh clone: dist/ is gitignored on purpose, because committing",
      "build output is the drift risk that vendoring was rejected for, and a consumer's",
      "install does not install THIS package's devDependencies.",
      "",
      "Fix, in the wiki-viewer repository:",
      "    pnpm install",
      "    pnpm --filter @wiki-viewer/viewer build",
      "",
      "Then re-run the install in the consuming project.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("@wiki-viewer/viewer: no dist found, building it now");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
