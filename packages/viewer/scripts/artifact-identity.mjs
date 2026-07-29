import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync as rfs } from "node:fs";

/**
 * Identify the artifact under test, in the output itself.
 *
 * This exists because a whole afternoon was lost to two sessions quoting
 * measurements of different bundles at each other: a grep of dist/ reported a
 * flag that had already been deleted, because content hashing had replaced the
 * file. Any pasted result must therefore say WHICH artifact produced it.
 */
export function artifactIdentity(distDir) {
  const chunk = readdirSync(distDir).find((f) => /^index-.*\.js$/.test(f));
  const file = `${distDir}/${chunk}`;
  const sha = createHash("sha256").update(rfs(file)).digest("hex").slice(0, 12);
  return `artifact: ${chunk}  sha256:${sha}  built:${statSync(file).mtime.toISOString()}`;
}
