/**
 * Bootstrap prompt copied into an external chatbot (ChatGPT, Claude, etc.) so it
 * can register with and operate a wiki-viewer instance. Served as the
 * `bootstrapPrompt` field of GET /api/agents/install.
 *
 * Kept as a build-time constant — not a runtime file read — so it works in dev,
 * production standalone builds, and global installs regardless of process.cwd().
 */
export const BOOTSTRAP_PROMPT = `You are connecting to a running wiki-viewer instance at $WIKI_URL (e.g. \`http://localhost:3000\`). Fetch \`$WIKI_URL/api/agents/install\` and follow the instructions there to register, wait for human approval, then work with files via its HTTP API. Fast path: when running directly on the wiki-viewer host, include the header \`X-Service-Token: <contents of ~/.wiki-viewer/service-token>\` on the register POST — registration auto-approves and the response carries your bearer token immediately (no approval wait).

**Two tiers — pick by \`X-Collab-State\`:**

- **Tier 1 Raw FS** (\`/api/agent/fs/*\`) — all file types, fast read/write/ls/search. Use for code, binaries, and markdown that isn't being actively co-edited.
- **Tier 2 Collab** (\`/api/agent/files/*.md\`) — block-scoped clean-markdown writes with revision/idempotency protection; activity feed provides provenance. Use when \`X-Collab-State: active\`.

**Mode rule:** Every file read returns \`X-Collab-State\`. If \`active\` → use Tier-2 block-ops so the human can review. Otherwise → use Tier-1 raw fs. A raw write to an \`active\` .md is rejected 409 \`COLLAB_ACTIVE\` with the Tier-2 URL.

**Workspaces:** this instance may serve several root directories. Send \`X-Workspace: <workspaceId>\` (or \`?ws=<id>\`) on every request to target one; omit it only on a single-workspace instance (the server falls back to the default). Ask the human for the workspace id or read it from the \`?ws=\` param of the URL they shared. A token may be pinned to one workspace — a mismatched workspace returns 403.

Tier-2 content ops write markdown with revision/idempotency checks. Legacy \`basis\`, \`basisDetail\`, and \`inResponseTo\` fields are accepted but ignored for backward compatibility. \`suggestion.add\` writes an inline \`<ins data-id>\` or \`<del data-id>\` mark into the document; the mark is the record and there is no sidecar suggestion or agent settle operation. Use direct block ops when the change should apply immediately.

MCP-capable agents: \`npx wiki-viewer-mcp\` (set \`WIKI_VIEWER_URL\`, \`WIKI_VIEWER_TOKEN\`, \`WIKI_VIEWER_AGENT_ID\`, and optionally \`WIKI_VIEWER_WORKSPACE\` to target a workspace) gives native **Tier-1 file tools** (read/write/edit/list/search/move/delete) and refuses to overwrite an \`active\` doc. It has **no Tier-2 collab tools** — to co-write a doc with comments or reviewable suggestion marks, call the Tier-2 HTTP endpoints directly. MCP = fast filework; Tier-2 HTTP = reviewable collaboration.
`;
