# Unified Live: impeccable experience for markdown + HTML

## Owner decree
"impeccable experience comes with wiki-viewer, but extended to also text/markdown files, not just html/webapps." The live responder is the user's **current chat agent session** (via MCP tools it calls), not a headless daemon.

## Foundational invariant (both consultants converged)
**Live is speculative until Accept. Accept is the only transition from proposal to canonical source, on every surface.**

This reverses two things shipped earlier this session, deliberately, because the async premises that justified them are gone (the agent is now live and in-session):
1. Markdown Live moves from **write-first-then-activity/audit provenance** to **write-on-accept** speculative preview.
2. The batch instruction-queue + RunReviewBar UX is removed from the Live path.

Proof-span provenance survives only as an *accepted-edit* audit mark and (optionally) for the separate non-Live async agent path. It is never a pending-review artifact in Live.

## Shared vocabulary (surface-neutral, user-facing)
| Concept | Term | HTML | Markdown |
|---|---|---|---|
| Thing changed | **Target** | DOM element | rendered block (text-range = pointing context) |
| Generated option | **Variant** | DOM/source candidate | markdown/source candidate |
| Pending candidate set | **Proposal** | N variants | N variants |
| Persist | **Accept** | apply source patch | apply block patch (tier-2 block.replace) |
| Abort | **Discard** | restore DOM | drop client state |
| Dispatch | **Go** | — | — |
| Surface-level ask | Steer | (deferred v2) | (deferred v2) |
| New content | Insert | new element | new block |

Retire user-facing "Instruct / Send / Tweak."

## Shared state machine (both surfaces)
Idle → Targeted → Waiting(agent) → Generating → Preview(cycle variants) → Accepted | Discarded | Invalidated(file changed underneath).

## Presence (honest, pull-based agent)
One indicator, two states everywhere:
- solid "● <agent> listening" only while a long-poll is currently held (presence TTL).
- pulsing amber "◌ no agent — Connect" otherwise.
Go is disabled when amber; the amber affordance **is** Connect. Instant feel = target flips to Generating the moment Go is pressed, before any agent reply. Grace window (~10s) prevents amber flicker during the agent's chat turns.

## Responder = chat agent via MCP tools
Delete the standalone `wiki-viewer-mcp live` daemon and its reference-agent runtime. Expose the live loop as MCP tools the chat agent calls: attach, poll (held), reply, snapshot, submit (variants), apply. Accept/Discard remain **human/UI-only** (trusted); the agent never commits source.

## Scope (v1)
IN: presence + Connect; select block/element (+ optional text-range); Go → Generating → 2–5 variants in place → cycle → Accept/Discard; write-on-accept everywhere; Insert; MCP live tools; delete daemon + write-first markdown review path.
OUT (cut): Steer; batch instruction-queue + RunReviewBar in Live; live knobs/sliders; freehand strokes; node-app HTML; multi-file candidates; multi-block markdown variants; comments-as-instructions (comments revert to plain comments).

## Biggest risk
Two review dialects surviving. Mitigation: total convergence — one commit gate (Accept), one verb set, one state machine. No Live path may write-first.

## Acceptance criteria
- Markdown Live never writes the file before Accept; Discard leaves the file byte-identical.
- HTML and markdown share verbs, presence, state machine, and commit semantics.
- The chat agent session (not a daemon) responds via MCP tools; `wiki-viewer-mcp live` subcommand no longer exists.
- Accept commits the exact selected variant verbatim through the one engine (tier-2 for markdown, source-patch for web), hash/revision-gated.
- Presence is solid only while a poll is held; Go is inert/Connect when amber.
- Full test suite green; typecheck + lint clean.
