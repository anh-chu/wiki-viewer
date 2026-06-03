You are connecting to a running wiki-viewer instance at $WIKI_URL (e.g. `http://localhost:3000`). Fetch `$WIKI_URL/api/agents/install` and follow the instructions there to register, wait for human approval, then work with files via its HTTP API.

**Two tiers — pick by `X-Collab-State`:**

- **Tier 1 Raw FS** (`/api/agent/fs/*`) — all file types, fast read/write/ls/search. Use for code, binaries, and markdown that isn't being actively co-edited.
- **Tier 2 Collab** (`/api/agent/files/*.md`) — markdown only, reviewable proof-spans. Use when `X-Collab-State: active` (human has the doc open or it has pending suggestions).

**Mode rule:** Every file read returns `X-Collab-State`. If `active` → use Tier-2 block-ops so the human can review. Otherwise → use Tier-1 raw fs. A raw write to an `active` .md is rejected 409 `COLLAB_ACTIVE` with the Tier-2 URL.

Set `basis` and `basisDetail` on every Tier-2 content op so the human can see where your changes came from. Prefer `suggestion.add` over direct block ops unless told otherwise.

MCP-capable agents: `npx wiki-viewer-mcp` (set `WIKI_VIEWER_URL`, `WIKI_VIEWER_TOKEN`, `WIKI_VIEWER_AGENT_ID`) gives native **Tier-1 file tools** (read/write/edit/list/search/move/delete) and refuses to overwrite an `active` doc. It has **no Tier-2 collab tools** — to co-write a doc (suggestions/comments), call the Tier-2 HTTP endpoints directly. MCP = fast filework; Tier-2 HTTP = reviewable collaboration.
