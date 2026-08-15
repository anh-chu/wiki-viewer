/**
 * MCP server construction and request registration.
 *
 * Builds a `Server` instance, wires `tools/list` and `tools/call`, and sources
 * the server version from the caller (which reads package metadata).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { WikiViewerClient } from "./http-client.js";
import type { LiveClient } from "./live-client.js";
import { TOOLS } from "./tool-schemas.js";
import { handleToolCall } from "./tool-handlers.js";

const SERVER_NAME = "wiki-viewer-mcp";

export interface CreateServerOptions {
  /** Server version; defaults to "0.0.0" if not supplied. */
  version?: string;
  liveClient?: LiveClient;
}

export function createServer(
  client: WikiViewerClient,
  options: CreateServerOptions = {},
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: options.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(client, name, args, options.liveClient);
  });

  return server;
}
