#!/usr/bin/env node
/**
 * wiki-viewer-mcp — MCP filesystem adapter for wiki-viewer agent API.
 *
 * Maps standard MCP filesystem tools onto the wiki-viewer HTTP agent API
 * described in docs/agent-fs-plan.md §2 + §3.5 + §6.
 *
 * Configuration (env vars):
 *   WIKI_VIEWER_URL      Base URL of wiki-viewer instance (required)
 *   WIKI_VIEWER_TOKEN    Bearer token from TOFU registration (required)
 *   WIKI_VIEWER_AGENT_ID X-Agent-Id header value (required)
 *
 * Mode-awareness:
 *   Before any raw write to a .md file, the shim checks the cached
 *   X-Collab-State from the last read. If "active", it blocks the write
 *   and instructs the agent to use Tier-2 block-ops instead.
 *   The server also enforces this (409 COLLAB_ACTIVE), which the shim
 *   surfaces cleanly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

import { parseArgs } from "node:util";
import { WikiViewerClient, IfMatchError, CollabActiveError, WikiViewerError, PatchUnsupportedError, MatchCountError } from "./http-client.js";
import * as stateCache from "./state-cache.js";

/**
 * Enable pooled HTTP keep-alive for the global fetch the client uses.
 *
 * Without this, every tool call opens a fresh connection and pays a full
 * TCP + TLS handshake (~3 RTT) before the request even goes out. Over a WAN
 * link that turns a sub-100ms write into 300ms-1s+, and multiplies across the
 * GET+PUT an edit performs. Reusing connections removes that per-call penalty.
 *
 * Wrapped in try/catch + dynamic import so a missing/edge undici never breaks
 * startup; it just falls back to default (non-pooled) fetch.
 */
async function enableKeepAlive(): Promise<void> {
  try {
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        connections: 16,
        pipelining: 1,
      }),
    );
  } catch {
    // undici unavailable — default fetch still works, just without pooling.
  }
}
import {
  register,
  RegisterScope,
  RegistrationDeniedError,
  RegistrationExpiredError,
  RegistrationTimeoutError,
} from "./register.js";

// ─── Config ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function createClient(overrides?: {
  baseUrl?: string;
  token?: string;
  agentId?: string;
  fetch?: typeof fetch;
}): WikiViewerClient {
  return new WikiViewerClient({
    baseUrl: overrides?.baseUrl ?? requireEnv("WIKI_VIEWER_URL"),
    token: overrides?.token ?? requireEnv("WIKI_VIEWER_TOKEN"),
    agentId: overrides?.agentId ?? requireEnv("WIKI_VIEWER_AGENT_ID"),
    fetch: overrides?.fetch,
  });
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const ReadFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  range: z.string().optional().describe("HTTP Range header value, e.g. 'bytes=0-1023'"),
});

const WriteFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  content: z.string().describe("File content (text)"),
  mkdirs: z.boolean().optional().describe("Create parent directories if missing"),
  force: z.boolean().optional().describe("Skip If-Match guard (audited)"),
  ifCollabMatch: z.number().optional().describe("If-Collab-Match revision (for tracked .md)"),
});

const EditFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  find: z.string().describe("Exact string to find (first occurrence)"),
  replace: z.string().describe("Replacement string"),
});

const ListDirectoryInput = z.object({
  path: z.string().describe("Directory path relative to wiki root"),
  recursive: z.boolean().optional().describe("List recursively"),
  depth: z.number().optional().describe("Max depth for recursive listing"),
  limit: z.number().optional().describe("Max entries to return"),
});

const SearchInput = z.object({
  kind: z.enum(["grep", "glob"]).describe("grep = text search, glob = path pattern"),
  query: z.string().describe("Search query or glob pattern"),
  path: z.string().optional().describe("Root path to search within"),
  glob: z.string().optional().describe("File glob filter for grep"),
  limit: z.number().optional().describe("Max matches to return"),
});

const MoveFileInput = z.object({
  from: z.string().describe("Source path"),
  to: z.string().describe("Destination path"),
});

const DeleteFileInput = z.object({
  path: z.string().describe("File path to delete"),
  recursive: z.boolean().optional().describe("Delete directory recursively"),
  force: z.boolean().optional().describe("Skip If-Match guard (audited)"),
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a file from the wiki-viewer instance. Returns content and metadata. " +
      "Captures sha256 (ETag) and X-Collab-State for subsequent writes. " +
      "Always read before writing to get the current sha.",
    inputSchema: zodToJsonSchema(ReadFileInput),
  },
  {
    name: "write_file",
    description:
      "Write (create or overwrite) a file. " +
      "If you have previously read the file, the last known sha is sent as If-Match automatically — " +
      "you get a 412 error if the file changed since your read. " +
      "WARNING: for .md files with X-Collab-State 'active', raw writes are blocked — " +
      "use wiki-viewer block-ops (Tier 2) instead so the human can review your changes.",
    inputSchema: zodToJsonSchema(WriteFileInput),
  },
  {
    name: "edit_file",
    description:
      "Edit a file by exact string replacement (first occurrence). " +
      "Implemented client-side as: read → str-replace → PUT with If-Match. " +
      "Returns an error if the find string is not found or the file is collab-active. " +
      "For .md files, prefer block-ops if X-Collab-State is 'active'.",
    inputSchema: zodToJsonSchema(EditFileInput),
  },
  {
    name: "list_directory",
    description: "List directory contents. Scope-filtered; .proof/ is hidden.",
    inputSchema: zodToJsonSchema(ListDirectoryInput),
  },
  {
    name: "search",
    description:
      "Search files. kind='grep' searches file contents; kind='glob' matches paths. " +
      "Server-side — avoids round-trip explosion from ls+read patterns.",
    inputSchema: zodToJsonSchema(SearchInput),
  },
  {
    name: "move_file",
    description:
      "Move or rename a file. Sidecar (.proof/*.json) is moved automatically for .md files.",
    inputSchema: zodToJsonSchema(MoveFileInput),
  },
  {
    name: "delete_file",
    description:
      "Delete a file. Requires 'delete' scope. You must have read the file first " +
      "(its sha is sent as If-Match). .md sidecars are removed automatically.",
    inputSchema: zodToJsonSchema(DeleteFileInput),
  },
] as const;

// ─── Handler helpers ──────────────────────────────────────────────────────────

function isMd(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".markdown");
}

function collabActiveMessage(path: string, snapshotUrl: string | null): string {
  const tier2 = snapshotUrl
    ? `\nTier-2 block-ops snapshot: ${snapshotUrl}`
    : "";
  return (
    `⚠️  COLLAB ACTIVE: "${path}" is being actively collaborated on by a human.\n` +
    `Raw writes are blocked to protect pending review artifacts.\n` +
    `→ Use wiki-viewer Tier-2 block-ops (POST /api/agent/files/<path>.md with block.replace / suggestion.*) so your edit becomes a reviewable suggestion.${tier2}\n` +
    `→ Alternatively, re-read the file and pass ifCollabMatch with the current X-Collab-Revision if you have confirmed with the human that a direct raw write is intended.`
  );
}

function ifMatchMismatchMessage(path: string): string {
  return (
    `412 If-Match mismatch for "${path}" — the file changed since you last read it.\n` +
    `Re-read the file with read_file to get the current content and sha, then retry.`
  );
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${text}` }] };
}

/**
 * Check cached collab state before a write.
 * Returns a blocking error message if write should not proceed, or null if ok.
 */
function checkCollabBlock(path: string): string | null {
  if (!isMd(path)) return null;
  const cached = stateCache.get(path);
  if (!cached) return null; // no prior read — let server enforce
  if (cached.collabState === "active") {
    return collabActiveMessage(path, cached.collabSnapshot);
  }
  return null;
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createServer(client: WikiViewerClient): Server {
  const server = new Server(
    { name: "wiki-viewer-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── read_file ───────────────────────────────────────────────────────
        case "read_file": {
          const { path, range } = ReadFileInput.parse(args);
          const result = await client.readFile(path, range);

          const collabNote = result.collabState !== "not-markdown"
            ? `\nX-Collab-State: ${result.collabState}` +
              (result.collabRevision !== null ? `\nX-Collab-Revision: ${result.collabRevision}` : "") +
              (result.collabSnapshot ? `\nX-Collab-Snapshot: ${result.collabSnapshot}` : "") +
              (result.collabState === "active"
                ? "\n⚠️  File is COLLAB ACTIVE — use block-ops for edits so human can review."
                : result.collabState === "tracked"
                ? "\nFile is tracked — prefer block-ops for prose/semantic edits."
                : "")
            : "";

          if (result.text !== null) {
            return ok(
              `File: ${path}\nSize: ${result.size} bytes | ETag: ${result.sha256}${collabNote}\n\n${result.text}`,
            );
          } else {
            return ok(
              `File: ${path}\nSize: ${result.size} bytes | ETag: ${result.sha256}\nContent-Type: ${result.contentType} (binary — use range reads for partial content)${collabNote}`,
            );
          }
        }

        // ── write_file ──────────────────────────────────────────────────────
        case "write_file": {
          const { path, content, mkdirs, force, ifCollabMatch } = WriteFileInput.parse(args);

          // Client-side collab guard
          const block = checkCollabBlock(path);
          if (block) return err(block);

          const cached = stateCache.get(path);
          const ifMatch = cached?.sha256;

          const result = await client.writeFile(path, content, {
            ifMatch,
            mkdirs,
            force,
            ifCollabMatch,
          });

          return ok(
            `Written: ${path}\nSha256: ${result.sha256}\nSize: ${result.size} bytes\n${result.created ? "Created (new file)" : "Overwritten"}`,
          );
        }

        // ── edit_file ───────────────────────────────────────────────────────
        case "edit_file": {
          const { path, find, replace } = EditFileInput.parse(args);

          // Client-side collab guard
          const block = checkCollabBlock(path);
          if (block) return err(block);

          // Best path: server-side PATCH str-replace — sends only {find,replace}
          // (~hundreds of bytes) instead of the whole file. One small request.
          // Requires a known sha (If-Match); use cached sha if present, else the
          // server's 412-recover path handles it. Falls back to read+PUT if the
          // server has no PATCH route (older version).
          const cachedForPatch = stateCache.get(path);
          if (cachedForPatch?.collabState !== "active") {
            try {
              const r = await client.patchFile(path, find, replace, {
                ifMatch: cachedForPatch?.sha256,
              });
              return ok(
                `Edited: ${path}\nReplaced ${JSON.stringify(find)} → ${JSON.stringify(replace)}\nNew sha256: ${r.sha256}`,
              );
            } catch (e) {
              if (e instanceof MatchCountError) {
                return err(
                  `edit_file: expected to replace exactly 1 occurrence of ${JSON.stringify(find)} in "${path}", ` +
                  `but found ${e.found}. Re-read the file or make the search string unique.`,
                );
              }
              if (e instanceof CollabActiveError) {
                return err(collabActiveMessage(path, e.snapshotUrl));
              }
              if (e instanceof IfMatchError) {
                // sha was stale — fall through to read+retry below.
              } else if (!(e instanceof PatchUnsupportedError)) {
                throw e;
              }
              // PatchUnsupportedError or stale If-Match → fall back to read+PUT.
            }
          }

          // Fallback path: read → transform → PUT with If-Match.
          const readResult = await client.readFile(path);
          if (readResult.text === null) {
            return err(`edit_file: "${path}" appears to be binary — cannot do text replacement.`);
          }
          if (readResult.collabState === "active") {
            return err(collabActiveMessage(path, readResult.collabSnapshot));
          }
          if (!readResult.text.includes(find)) {
            return err(
              `edit_file: string not found in "${path}".\n` +
              `Search for: ${JSON.stringify(find)}\n` +
              `Tip: re-read the file to see current content.`,
            );
          }

          const newContent = readResult.text.replace(find, replace);
          const writeResult = await client.writeFile(path, newContent, {
            ifMatch: readResult.sha256,
          });

          return ok(
            `Edited: ${path}\nReplaced ${JSON.stringify(find)} → ${JSON.stringify(replace)}\nNew sha256: ${writeResult.sha256}`,
          );
        }

        // ── list_directory ──────────────────────────────────────────────────
        case "list_directory": {
          const { path, recursive, depth, limit } = ListDirectoryInput.parse(args);
          const entries = await client.listDirectory(path, { recursive, depth, limit });
          const lines = entries.map(
            (e) =>
              `${e.type === "directory" ? "DIR " : "FILE"} ${e.path}` +
              (e.size !== null ? ` (${e.size}b)` : "") +
              (e.mtime ? ` [${e.mtime}]` : ""),
          );
          return ok(lines.length > 0 ? lines.join("\n") : "(empty directory)");
        }

        // ── search ──────────────────────────────────────────────────────────
        case "search": {
          const body = SearchInput.parse(args);
          const result = await client.search(body);
          if (result.matches.length === 0) {
            return ok("No matches found.");
          }
          const lines = result.matches.map((m) => {
            if (result.kind === "grep" && m.line !== undefined) {
              return `${m.path}:${m.line}: ${m.text ?? ""}`;
            }
            return m.path;
          });
          return ok(`${result.matches.length} match(es):\n${lines.join("\n")}`);
        }

        // ── move_file ───────────────────────────────────────────────────────
        case "move_file": {
          const { from, to } = MoveFileInput.parse(args);
          const cached = stateCache.get(from);
          await client.moveFile(from, to, cached?.sha256);
          return ok(`Moved: ${from} → ${to}`);
        }

        // ── delete_file ─────────────────────────────────────────────────────
        case "delete_file": {
          const { path, recursive, force } = DeleteFileInput.parse(args);
          const cached = stateCache.get(path);
          if (!cached?.sha256) {
            return err(
              `delete_file: no cached sha for "${path}" — read the file first with read_file so the current sha can be sent as If-Match.`,
            );
          }
          await client.deleteFile(path, cached.sha256, { recursive, force });
          return ok(`Deleted: ${path}`);
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      if (e instanceof IfMatchError) {
        return err(ifMatchMismatchMessage(e.message.match(/"([^"]+)"/)?.at(1) ?? "file"));
      }
      if (e instanceof CollabActiveError) {
        return err(collabActiveMessage(e.message, e.snapshotUrl));
      }
      if (e instanceof WikiViewerError) {
        return err(`wiki-viewer error ${e.status} (${e.code}): ${e.message}`);
      }
      if (e instanceof z.ZodError) {
        return err(`Invalid arguments: ${e.message}`);
      }
      throw e; // unexpected — let MCP transport handle
    }
  });

  return server;
}

// ─── Inline minimal JSON-schema conversion ────────────────────────────────────
// Uses Zod v4 _def.type discriminator (v4 removed _def.typeName).

type AnyZodVal = { _def: { type: string; description?: string; innerType?: AnyZodVal; entries?: Record<string, string>; options?: string[] }; description?: string; options?: string[]; unwrap?: () => AnyZodVal };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = schema.shape as Record<string, any>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    const v = val as AnyZodVal;
    const isOptional = v._def.type === "optional";
    const inner: AnyZodVal = isOptional ? (v.unwrap ? v.unwrap() : v._def.innerType ?? v) : v;

    properties[key] = buildJsonSchema(inner);
    if (!isOptional) required.push(key);
  }

  return { type: "object", properties, required };
}

function buildJsonSchema(val: AnyZodVal): Record<string, unknown> {
  const desc = val.description ?? val._def.description;
  const withDesc = (s: Record<string, unknown>) => { if (desc) s["description"] = desc; return s; };

  switch (val._def.type) {
    case "string": return withDesc({ type: "string" });
    case "number": return withDesc({ type: "number" });
    case "boolean": return withDesc({ type: "boolean" });
    case "enum": {
      const opts = val.options ?? Object.keys(val._def.entries ?? {});
      return withDesc({ type: "string", enum: opts });
    }
    case "optional": return buildJsonSchema(val.unwrap ? val.unwrap() : val._def.innerType ?? val);
    default: return withDesc({ type: "string" });
  }
}

// ─── Entrypoints ─────────────────────────────────────────────────────────────

async function main() {
  await enableKeepAlive();
  const client = createClient();
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

/**
 * CLI entry: routes to `register` subcommand or MCP stdio server.
 * Only called when the file is the actual entry point (not imported in tests).
 */
async function runCli() {
  // Detect subcommand: first positional arg
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const subcommand = positional[0];

  if (subcommand === "register") {
    await runRegister();
  } else {
    await main();
  }
}

async function runRegister() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      "scope-paths": { type: "string", default: "**/*" },
      ops: { type: "string", default: "read,mutate" },
      timeout: { type: "string", default: "300" },
    },
    allowPositionals: true,
  });

  if (!values.url) {
    console.error("Error: --url is required (e.g. https://notes.example.com)");
    process.exit(1);
  }
  if (!values.id) {
    console.error("Error: --id is required (e.g. ai:myagent)");
    process.exit(1);
  }
  if (!values.name) {
    console.error("Error: --name is required (e.g. \"My Agent\")");
    process.exit(1);
  }
  if (!values.id.match(/^ai:[a-z][a-z0-9-]{0,30}$/)) {
    console.error("Error: --id must match ^ai:[a-z][a-z0-9-]{0,30}$ (e.g. ai:myagent)");
    process.exit(1);
  }

  const scopePaths = (values["scope-paths"] ?? "**/*").split(",").map((p) => p.trim());
  const rawOps = (values.ops ?? "read,mutate").split(",").map((o) => o.trim());
  const validOps = ["read", "mutate", "delete"] as const;
  const ops = rawOps.filter((o): o is typeof validOps[number] => (validOps as readonly string[]).includes(o));
  if (ops.length === 0) {
    console.error("Error: --ops must include at least one of: read, mutate, delete");
    process.exit(1);
  }
  const scope: RegisterScope = { paths: scopePaths, ops };
  const timeoutMs = parseInt(values.timeout ?? "300", 10) * 1000;

  console.log(`Registering agent ${values.id} with ${values.url} …`);
  console.log(`Scope: paths=${JSON.stringify(scopePaths)}, ops=${JSON.stringify(ops)}`);
  console.log();

  try {
    const result = await register({
      baseUrl: values.url,
      id: values.id,
      displayName: values.name,
      scope,
      timeoutMs,
      onPending: (_id, attempt) => {
        if (attempt === 1) {
          console.log(
            `⏳ Waiting for approval. Open the wiki-viewer AI Panel and approve agent "${values.id}".`,
          );
        } else if (attempt % 10 === 0) {
          console.log(`   Still waiting… (${attempt * 3}s elapsed)`);
        }
      },
    });

    console.log();
    console.log("✅ Approved!");
    console.log();
    console.log(`Agent ID : ${result.agentId}`);
    console.log(`Token    : ${result.token}`);
    console.log();
    console.log("Paste this into your mcp.json:");
    console.log();
    console.log(JSON.stringify({
      servers: {
        "wiki-viewer": {
          command: "npx",
          args: ["wiki-viewer-mcp"],
          env: {
            WIKI_VIEWER_URL: values.url,
            WIKI_VIEWER_TOKEN: result.token,
            WIKI_VIEWER_AGENT_ID: result.agentId,
          },
        },
      },
    }, null, 2));
    process.exit(0);
  } catch (e) {
    if (
      e instanceof RegistrationDeniedError ||
      e instanceof RegistrationExpiredError ||
      e instanceof RegistrationTimeoutError
    ) {
      console.error(`\n❌ ${e.message}`);
    } else {
      console.error("\n❌ Unexpected error:", e);
    }
    process.exit(1);
  }
}

// Only auto-start when this file is the entry point, not when imported in tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\/dist\//, "/src/").replace(/\.js$/, ".ts"))) {
  runCli().catch((e) => {
    console.error("wiki-viewer-mcp fatal:", e);
    process.exit(1);
  });
} else if (
  // Also run when invoked as the compiled binary
  process.argv[1] &&
  (process.argv[1].endsWith("wiki-viewer-mcp") || process.argv[1].endsWith("index.js")) &&
  !process.argv[1].includes("__tests__")
) {
  runCli().catch((e) => {
    console.error("wiki-viewer-mcp fatal:", e);
    process.exit(1);
  });
}
