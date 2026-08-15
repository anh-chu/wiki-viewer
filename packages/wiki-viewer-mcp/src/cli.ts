/**
 * CLI entry: stdio MCP server and `register` subcommand routing.
 */

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { WikiViewerClient } from "./http-client.js";
import { createServer } from "./server.js";
import { LiveClient } from "./live-client.js";
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
  const server = createServer(client, { version: readPackageVersion(), liveClient: createLiveClient() });
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
