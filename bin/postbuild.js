#!/usr/bin/env node
// Post-build fixups for the Next.js standalone bundle so it survives `npm pack`
// and runs from a clean install. Run after `next build`.
//
// Four problems this addresses:
//
// 1. Static assets and public/ are not copied into the standalone output by
//    Next, so we copy them in.
//
// 2. Next writes a .gitignore into .next/standalone that lists node_modules/
//    and .next/. npm honors nested .gitignore files when packing, which strips
//    the bundled runtime and compiled server from the tarball. Remove it.
//
// 3. Next 16.1+ with Turbopack emits content-hashed require ids for external
//    packages, e.g. require("sharp-cf218e5bd1d5f04c"). That hashed id does not
//    exist in node_modules, so the server throws "Cannot find module" at
//    runtime. Rewrite every hashed external require back to its real package
//    name. See vercel/next.js#88844 and #91654.
//
// 4. Under pnpm, standalone/node_modules is a .pnpm store plus symlinks. npm
//    pack silently drops symlinks while keeping the store's real files, so the
//    tarball extracts to a tree where `require("next")` fails. Flatten the
//    store into a real hoisted tree (step 6).

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, lstatSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// 4. Next traces from the pnpm workspace root and copies the whole repo into
// standalone (including .git, source, docs, lockfiles). None of it is used at
// runtime: the server runs the compiled bundle under .next/. Prune the cruft so
// the published tarball stays small. Keep only what the server needs:
// server.js, .next/, node_modules/, public/, package.json.
const PRUNE = [
  ".git", ".github", ".handoffs", ".pi", "certificates", "docs", "packages",
  "src", "agents", "AGENTS.md", "CLAUDE.md", "DESIGN.md", "README.md",
  "TODO.md", "pnpm-lock.yaml", "pnpm-workspace.yaml", "postcss.config.mjs",
  "tailwind.config.ts", "tsconfig.json", "tsconfig.tsbuildinfo", "bin",
];
let pruned = 0;
for (const name of PRUNE) {
  const target = path.join(standalone, name);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    pruned++;
  }
}
console.log(`postbuild: pruned ${pruned} traced repo path(s) from standalone`);

// 5. Copy the ripgrep binary into standalone so the server can find it at
//    node_modules/@vscode/ripgrep-<plat>-<arch>/bin/<binName>.
//    The server probes this exact flat path at runtime (and also tries
//    createRequire.resolve from the wrapper's directory). This is explicit
//    rather than relying on Next's output file tracing because:
//    (a) server code deliberately never requires @vscode/ripgrep, so there
//        is nothing for the tracer to follow;
//    (b) step 3 above already works around Turbopack external-require
//        fragility for native packages.
//    DO NOT prune node_modules/@vscode/ripgrep-* from standalone — this copy
//    is the only thing keeping the bundled binary alive.
const arch = process.env.npm_config_arch || process.arch;
const binName = process.platform === "win32" ? "rg.exe" : "rg";
const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
const rgDstRel = path.join("node_modules", platformPkg, "bin", binName);
const rgDst = path.join(standalone, rgDstRel);

let rgSrc = null;
// Resolve via the wrapper's require chain (layout-agnostic, same mechanism
// the wrapper's index.js uses at runtime).
try {
  const wrapperFile = fileURLToPath(import.meta.resolve("@vscode/ripgrep"));
  const req = createRequire(wrapperFile);
  rgSrc = req.resolve(`${platformPkg}/bin/${binName}`);
} catch {
  // import.meta.resolve / createRequire unavailable — fs fallback below
}

// Fallback: search under node_modules/.pnpm
if (!rgSrc || !existsSync(rgSrc)) {
  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    const prefix = `@vscode+ripgrep-${process.platform}-${arch}@`;
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith(prefix)) {
        const candidate = path.join(pnpmDir, entry, "node_modules", platformPkg, "bin", binName);
        if (existsSync(candidate)) { rgSrc = candidate; break; }
      }
    }
  }
}

if (rgSrc && existsSync(rgSrc)) {
  mkdirSync(path.dirname(rgDst), { recursive: true });
  // cpSync preserves file mode by default, including executable bit
  cpSync(rgSrc, rgDst);
  console.log(`postbuild: copied rg binary to ${path.relative(root, rgDst)}`);
} else {
  console.warn("WARNING: @vscode/ripgrep platform binary not found");
  console.warn("  The published package will rely on the consumer's PATH for ripgrep.");
  console.warn("  Install @vscode/ripgrep (optional dep) or ensure rg is on PATH.");
}

// 6. Flatten pnpm's symlink farm into a real hoisted tree.
//
// pnpm lays out standalone/node_modules as a .pnpm content store plus symlinks
// pointing into it, both at the top level (next, react) and nested inside each
// store entry for peer deps (next -> @swc/helpers). `npm pack` follows neither:
// it packs the store's real files and drops every symlink, so the extracted
// tarball has the bytes but no resolvable package names.
//
// Hoisting is safe here because the traced runtime set contains no duplicate
// package names at differing versions. That is asserted below rather than
// assumed, because a future dependency bump could introduce one and flattening
// would then silently drop a version.
//
// This runs last so it cannot disturb the ripgrep binary step 5 places at a
// flat path. Any top-level entry that is already a real directory is left
// alone for that reason.
const nodeModules = path.join(standalone, "node_modules");
const pnpmStore = path.join(nodeModules, ".pnpm");

if (existsSync(pnpmStore)) {
  // Collect every real package directory in the store, keyed by package name.
  const found = new Map();
  const conflicts = [];

  const record = (name, full) => {
    // Symlinks are peer-dep pointers to other store entries; the real copy is
    // recorded when we reach the store entry that owns it.
    const st = lstatSync(full);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    if (found.has(name)) {
      conflicts.push(name);
      return;
    }
    found.set(name, full);
  };

  for (const storeEntry of readdirSync(pnpmStore)) {
    const inner = path.join(pnpmStore, storeEntry, "node_modules");
    if (!existsSync(inner)) continue;

    for (const entry of readdirSync(inner)) {
      if (entry === ".bin") continue;

      if (entry.startsWith("@")) {
        const scopeDir = path.join(inner, entry);
        if (!lstatSync(scopeDir).isDirectory()) continue;
        for (const scoped of readdirSync(scopeDir)) {
          record(`${entry}/${scoped}`, path.join(scopeDir, scoped));
        }
      } else {
        record(entry, path.join(inner, entry));
      }
    }
  }

  if (conflicts.length) {
    console.error(`ERROR: cannot flatten standalone node_modules, duplicate versions of: ${[...new Set(conflicts)].join(", ")}`);
    console.error("  Hoisting would drop one version. Resolve the duplicate dependency before publishing.");
    process.exit(1);
  }

  // sharp is an optional dependency of next, required lazily by the
  // /_next/image optimizer (next/dist/server/image-optimizer.js does
  // `_sharp = require('sharp')` inside a function, never at module scope).
  // This app imports next/image nowhere and sets images.unoptimized, so that
  // code path is unreachable and sharp is dead weight.
  //
  // Excluding it matters for more than the ~11MB: @img/sharp-<platform> is a
  // prebuilt .node binary chosen for the *publishing* machine. Because publish
  // is pack+tar with no install step, that binary would be frozen into the
  // tarball and fail to load on any other OS/arch. Dropping it leaves the
  // package free of platform-locked native binaries.
  //
  // Note this is the same failure mode that shipped a Node-22-ABI
  // better_sqlite3.node in 2.8.0; there the axis was ABI, here it is platform.
  const isExcluded = (name) => name === "sharp" || name.startsWith("@img/");

  let hoisted = 0;
  let excluded = 0;
  for (const [name, src] of found) {
    if (isExcluded(name)) {
      excluded++;
      continue;
    }

    const dst = path.join(nodeModules, name);

    // lstat, not existsSync: a symlink whose target has already been hoisted
    // is dangling, and existsSync would report it as absent.
    const present = lstatSync(dst, { throwIfNoEntry: false });
    if (present) {
      // A real directory here was placed deliberately (step 5's rg binary).
      if (!present.isSymbolicLink()) continue;
      rmSync(dst);
    }

    mkdirSync(path.dirname(dst), { recursive: true });
    renameSync(src, dst);
    hoisted++;
  }

  // Skipping the hoist above leaves these inside .pnpm, which is removed below.
  // These removals cover the other placement: a copy Next wrote directly to the
  // top level rather than through the store.
  for (const rel of ["sharp", "@img"]) {
    rmSync(path.join(nodeModules, rel), { recursive: true, force: true });
  }

  rmSync(pnpmStore, { recursive: true, force: true });
  console.log(`postbuild: hoisted ${hoisted} package(s) out of the pnpm store`);
  console.log(`postbuild: excluded ${excluded} unreachable native package(s) (sharp/@img)`);

  // Nothing may resolve through a symlink after this point, or npm pack will
  // drop it again and the failure only surfaces on a user's machine.
  const leftovers = [];
  (function scan(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) leftovers.push(path.relative(standalone, full));
      else if (st.isDirectory()) scan(full);
    }
  })(nodeModules);

  if (leftovers.length) {
    console.error(`ERROR: ${leftovers.length} symlink(s) survived flattening, npm pack would drop them:`);
    for (const l of leftovers.slice(0, 10)) console.error(`  ${l}`);
    process.exit(1);
  }
  console.log("postbuild: standalone node_modules is symlink-free");
}

console.log("postbuild: done");
