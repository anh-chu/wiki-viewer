/**
 * CLI entry: stdio MCP server and `register` subcommand routing.
 */

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { WikiViewerClient } from "./http-client.js";
import { createServer } from "./server.js";
import {
  LiveClient,
  runLiveLoop,
  type LiveHandler,
  type BlockOp,
  type WebTweakHandler,
  type WebVariantsHandler,
  type WebVariant,
  type DomOp,
} from "./live-client.js";
import {
  register,
  type RegisterScope,
  RegistrationDeniedError,
  RegistrationExpiredError,
  RegistrationTimeoutError,
} from "./register.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function createClient(overrides?: {
  baseUrl?: string;
  token?: string;
  agentId?: string;
  workspace?: string;
  fetch?: typeof fetch;
}): WikiViewerClient {
  return new WikiViewerClient({
    baseUrl: overrides?.baseUrl ?? requireEnv("WIKI_VIEWER_URL"),
    token: overrides?.token ?? requireEnv("WIKI_VIEWER_TOKEN"),
    agentId: overrides?.agentId ?? requireEnv("WIKI_VIEWER_AGENT_ID"),
    workspace: overrides?.workspace ?? process.env.WIKI_VIEWER_WORKSPACE,
    fetch: overrides?.fetch,
  });
}

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

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  try {
    const pkg = require("../package.json");
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(): Promise<void> {
  await enableKeepAlive();
  const client = createClient();
  const server = createServer(client, { version: readPackageVersion() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

/**
 * CLI entry: routes to `register` subcommand or MCP stdio server.
 */
export async function runCli(): Promise<void> {
  // Detect subcommand: first positional arg
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const subcommand = positional[0];

  if (subcommand === "register") {
    await runRegister();
  } else if (subcommand === "live") {
    await runLive();
  } else {
    await main();
  }
}

/**
 * Create a LiveClient from env (same vars as the MCP client).
 */
export function createLiveClient(overrides?: {
  baseUrl?: string;
  token?: string;
  agentId?: string;
  workspace?: string;
  fetch?: typeof fetch;
}): LiveClient {
  return new LiveClient({
    baseUrl: overrides?.baseUrl ?? requireEnv("WIKI_VIEWER_URL"),
    token: overrides?.token ?? requireEnv("WIKI_VIEWER_TOKEN"),
    agentId: overrides?.agentId ?? requireEnv("WIKI_VIEWER_AGENT_ID"),
    workspace: overrides?.workspace ?? process.env.WIKI_VIEWER_WORKSPACE,
    fetch: overrides?.fetch,
  });
}

/**
 * Built-in passthrough handler: treats the human's instruction as the literal
 * new markdown for the selected block. This is a functional reference agent
 * (useful for smoke tests and scripting); real LLM agents should import
 * runLiveLoop and supply their own handler.
 */
export const passthroughHandler: LiveHandler = async (req) => {
  const instruction = (req.instruction ?? "").trim();
  if (!instruction) return null;
  if (!req.blockRef) {
    // No target block — append as a new block at the end.
    const op: BlockOp = {
      type: "block.append",
      markdown: instruction,
      basis: "described",
      basisDetail: "live instruction (passthrough)",
    };
    return [op];
  }
  const op: BlockOp = {
    type: "block.replace",
    ref: req.blockRef,
    markdown: instruction,
    basis: "described",
    basisDetail: "live instruction (passthrough)",
  };
  return [op];
};

/**
 * Built-in passthrough web-tweak handler: a functional reference agent for smoke
 * tests. It turns the human note into a trivial data-only DOM preview op (a color
 * mention becomes a setStyle color; otherwise the note becomes setText). By
 * default it produces a visual-only preview (null candidate). If the note starts
 * with "commit:" it also emits a real whole-file replacement candidate, pinning
 * baseFiles via client.fetchFileForHash so accept can re-check the hash.
 *
 * Never writes source directly: it only returns the candidate + base hashes; the
 * server commits verbatim on human accept.
 */
/** Map one note to a data-only DOM preview op (color -> setStyle, else setText). */
function noteToDomOp(note: string): DomOp {
  const colorMatch = note.match(
    /\b(red|green|blue|black|white|orange|purple|yellow|pink|gray|grey|#[0-9a-fA-F]{3,8})\b/,
  );
  return colorMatch
    ? { type: "setStyle", prop: "color", value: colorMatch[1] }
    : { type: "setText", value: note };
}

export const passthroughWebHandler: WebTweakHandler = async (ctx, { client }) => {
  const note = (ctx.note ?? "").trim();

  // Batch run: one preview per pinned instruction, correlated by instructionId.
  // Visual-only (no source candidate) — the passthrough agent is a smoke test.
  if (ctx.items && ctx.items.length > 0) {
    return {
      domPreviewOps: null,
      candidateSourcePatch: null,
      baseFiles: [],
      itemPreviews: ctx.items.map((it) => ({
        instructionId: it.instructionId,
        ops: [noteToDomOp((it.note ?? "").trim())],
      })),
    };
  }

  const domPreviewOps: DomOp[] = [noteToDomOp(note)];

  const commit = note.toLowerCase().startsWith("commit:");
  if (!commit) {
    // Visual-only preview: not acceptable as a source change.
    return { domPreviewOps, candidateSourcePatch: null, baseFiles: [] };
  }

  // Real candidate: derive a whole-file replacement against the current file.
  const { content, sha256 } = await client.fetchFileForHash(ctx.path);
  const newContent = `${content}\n<!-- ${note} -->\n`;
  return {
    domPreviewOps,
    candidateSourcePatch: {
      files: [{ path: ctx.path, content: newContent }],
      summary: note,
    },
    baseFiles: [{ path: ctx.path, sha256 }],
  };
};

/**
 * Built-in passthrough variants handler: a functional reference agent for smoke
 * tests. It derives 2-3 visual-only candidate options from the human note by
 * reusing noteToDomOp for a couple of color/text variations. Each variant is
 * visual-only (null candidateSourcePatch) unless the note starts with "commit:",
 * in which case the first variant carries a real whole-file replacement candidate
 * pinned via client.fetchFileForHash so accept can re-check the hash.
 */
export const passthroughVariantsHandler: WebVariantsHandler = async (ctx, { client }) => {
  const note = (ctx.note ?? "").trim();

  // A small spread of visual-only options derived from the note.
  const variants: WebVariant[] = [
    {
      variantId: "v1",
      label: note || "option 1",
      domPreviewOps: [noteToDomOp(note)],
      candidateSourcePatch: null,
      baseFiles: [],
    },
    {
      variantId: "v2",
      label: `${note || "option"} (bold)`,
      domPreviewOps: [{ type: "setStyle", prop: "font-weight", value: "bold" }],
      candidateSourcePatch: null,
      baseFiles: [],
    },
    {
      variantId: "v3",
      label: `${note || "option"} (emphasis)`,
      domPreviewOps: [{ type: "setStyle", prop: "text-decoration", value: "underline" }],
      candidateSourcePatch: null,
      baseFiles: [],
    },
  ];

  const commit = note.toLowerCase().startsWith("commit:");
  if (commit) {
    // Make the first variant committable: a whole-file replacement candidate.
    const { content, sha256 } = await client.fetchFileForHash(ctx.path);
    const newContent = `${content}\n<!-- ${note} -->\n`;
    variants[0] = {
      ...variants[0],
      candidateSourcePatch: {
        files: [{ path: ctx.path, content: newContent }],
        summary: note,
      },
      baseFiles: [{ path: ctx.path, sha256 }],
    };
  }

  return { variants };
};

async function runLive(): Promise<void> {
  await enableKeepAlive();
  const client = createLiveClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.error("[live] attaching — waiting for block-scoped requests. Ctrl-C to stop.");
  await runLiveLoop(client, passthroughHandler, {
    signal: controller.signal,
    webHandler: passthroughWebHandler,
    webVariantsHandler: passthroughVariantsHandler,
    onEvent: (event, detail) => {
      const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
      console.error(`[live] ${event}${suffix}`);
    },
  });
  console.error("[live] stopped.");
}

async function runRegister(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      "scope-paths": { type: "string", default: "**/*" },
      ops: { type: "string", default: "read,mutate" },
      timeout: { type: "string", default: "300" },
      workspace: { type: "string" },
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
  const ops = rawOps.filter((o): o is typeof validOps[number] =>
    (validOps as readonly string[]).includes(o),
  );
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
    console.log(
      JSON.stringify(
        {
          servers: {
            "wiki-viewer": {
              command: "npx",
              args: ["wiki-viewer-mcp"],
              env: {
                WIKI_VIEWER_URL: values.url,
                WIKI_VIEWER_TOKEN: result.token,
                WIKI_VIEWER_AGENT_ID: result.agentId,
                ...(values.workspace ? { WIKI_VIEWER_WORKSPACE: values.workspace } : {}),
              },
            },
          },
        },
        null,
        2,
      ),
    );
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
