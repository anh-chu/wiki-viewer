/**
 * Build stamp, printed at the top of every gate.
 *
 * Two sessions lost several exchanges to an unfalsifiable disagreement: each was
 * measuring a different artifact and neither could tell. Worse, a CONTENT HASH was
 * used as evidence of freshness, which it is not: Vite empties dist and re-hashes
 * on every build, so a new hash proves the artifact is DIFFERENT, never that it is
 * CURRENT relative to the source edit in question.
 *
 * So every claim now carries: the commit, whether the tree is dirty, the mtime of
 * the STABLE entry point, and a digest over the whole dist directory. Staleness
 * announces itself instead of being discovered by arguing.
 *
 * The digest covers all of dist rather than one file, because dist/index.js is a
 * thin re-export shim; and gates assert through that stable entry, never through a
 * hashed chunk filename, so chunk names stay an implementation detail nobody has
 * standing to grep.
 *
 * Requested by the planner (session 019f936d).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function digestTree(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name);
    hash.update(createHash("sha256").update(readFileSync(path.join(dir, name))).digest());
  }
  return { digest: hash.digest("hex").slice(0, 16), count: files.length };
}

export function buildStamp(distDir) {
  const root = path.resolve(distDir, "..");
  const commit = git(["rev-parse", "--short", "HEAD"], root) ?? "no-git";
  const dirty = git(["status", "--porcelain"], root);
  const state = dirty === null ? "unknown" : dirty.length ? "DIRTY" : "clean";
  const entry = path.join(distDir, "index.js");
  const entryMtime = statSync(entry).mtime.toISOString();
  const { digest, count } = digestTree(distDir);
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  return [
    `build stamp  v${version}  commit ${commit} (${state})`,
    `             entry dist/index.js  mtime ${entryMtime}`,
    `             dist digest sha256:${digest} over ${count} files`,
  ].join("\n");
}

/** Kept for callers that only want one line. */
export function artifactIdentity(distDir) {
  return buildStamp(distDir);
}
