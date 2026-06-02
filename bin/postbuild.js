#!/usr/bin/env node
// Post-build fixups for the Next.js standalone bundle so it survives `npm pack`
// and runs from a clean install. Run after `next build`.
//
// Three problems this addresses:
//
// 1. Static assets and public/ are not copied into the standalone output by
//    Next, so we copy them in.
//
// 2. Next writes a .gitignore into .next/standalone that lists node_modules/
//    and .next/. npm honors nested .gitignore files when packing, which strips
//    the bundled runtime and compiled server from the tarball. Remove it.
//
// 3. Next 16.1+ with Turbopack emits content-hashed require ids for external
//    packages, e.g. require("better-sqlite3-cf218e5bd1d5f04c"). That hashed id
//    does not exist in node_modules, so the server throws "Cannot find module"
//    at runtime. Rewrite every hashed external require back to its real package
//    name. See vercel/next.js#88844 and #91654.

import { cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next", "standalone");
const serverDir = path.join(standalone, ".next", "server");

function copy(from, to) {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true });
  console.log(`postbuild: copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

// 1. static + public
copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copy(path.join(root, "public"), path.join(standalone, "public"));

// 2. drop the nested .gitignore that would exclude node_modules/.next from npm pack
const nestedGitignore = path.join(standalone, ".gitignore");
if (existsSync(nestedGitignore)) {
  rmSync(nestedGitignore);
  console.log("postbuild: removed .next/standalone/.gitignore");
}

// 3. strip Turbopack content hashes from external require ids.
// Only rewrite inside require("...") and the Turbopack external helper
// e.x("...") so we never touch unrelated 16-hex string literals (e.g. a
// dev fallback secret). Matches `<pkg>-<16 hex>` as the quoted argument.
const HASH_RE = /((?:require|\.x)\(\s*["'])((?:@[\w.-]+\/)?[\w.-]+)-[0-9a-f]{16}(["'])/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (entry.endsWith(".js")) stripHashes(full);
  }
}

let rewrites = 0;
function stripHashes(file) {
  const src = readFileSync(file, "utf8");
  HASH_RE.lastIndex = 0;
  if (!HASH_RE.test(src)) return;
  HASH_RE.lastIndex = 0;
  const out = src.replace(HASH_RE, "$1$2$3");
  if (out !== src) {
    writeFileSync(file, out);
    rewrites++;
  }
}

if (existsSync(serverDir)) {
  walk(serverDir);
  console.log(`postbuild: stripped Turbopack hashes in ${rewrites} file(s)`);
}

console.log("postbuild: done");
