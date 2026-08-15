/**
 * Dispatch layer for the seven MCP filesystem tools.
 *
 * Parses arguments with the Zod schemas, calls the `WikiViewerClient`, maps
 * HTTP errors to agent-facing messages, and manages the read-state cache.
 */

import * as z from "zod";

import {
  WikiViewerClient,
  IfMatchError,
  CollabActiveError,
  WikiViewerError,
  PatchUnsupportedError,
  MatchCountError,
} from "./http-client.js";
import * as stateCache from "./state-cache.js";
import { LiveClient } from "./live-client.js";
import {
  ReadFileInput,
  WriteFileInput,
  EditFileInput,
  ListDirectoryInput,
  SearchInput,
  MoveFileInput,
  DeleteFileInput,
  LiveAttachInput, LivePollInput, LiveSnapshotInput, LiveReplyInput,
  LiveSubmitMarkdownInput, LiveSubmitWebInput,
} from "./tool-schemas.js";

// ─── Result helpers ───────────────────────────────────────────────────────────

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${text}` }] };
}

function requireLive(client?: LiveClient): LiveClient {
  if (!client) throw new Error("Live tools unavailable: no live client configured");
  return client;
}

// ─── Markdown / collab helpers ────────────────────────────────────────────────

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

// ─── Tool dispatch ────────────────────────────────────────────────────────────

export async function handleToolCall(
  client: WikiViewerClient,
  name: string,
  args: unknown,
  liveClient?: LiveClient,
): Promise<ToolResult> {
  try {
    switch (name) {
      // ── read_file ───────────────────────────────────────────────────────
      case "read_file": {
        const { path, range } = ReadFileInput.parse(args);
        const result = await client.readFile(path, range);

        const collabNote =
          result.collabState !== "not-markdown"
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
            const patchResult = await client.patchFile(path, find, replace, {
              ifMatch: cachedForPatch?.sha256,
            });
            return ok(
              `Edited: ${path}\nReplaced ${JSON.stringify(find)} → ${JSON.stringify(replace)}\nNew sha256: ${patchResult.sha256}`,
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

      case "live_attach": {
        const live = requireLive(liveClient); LiveAttachInput.parse(args);
        const sessionId = await live.attach();
        return ok(JSON.stringify({ sessionId, workspaceId: live.workspaceId ?? null }));
      }
      case "live_poll": {
        const live = requireLive(liveClient); const input = LivePollInput.parse(args);
        return ok(JSON.stringify(await live.poll(input.sessionId, input.afterSeq)));
      }
      case "live_snapshot": {
        const live = requireLive(liveClient); const { path } = LiveSnapshotInput.parse(args);
        return ok(JSON.stringify(await live.snapshot(path)));
      }
      case "live_reply": {
        const live = requireLive(liveClient); const input = LiveReplyInput.parse(args);
        await live.reply(input.requestId, input.status); return ok("ok");
      }
      case "live_submit_markdown": {
        const live = requireLive(liveClient); const input = LiveSubmitMarkdownInput.parse(args);
        await live.submitMarkdownPreview(input); return ok("ok");
      }
      case "live_submit_web": {
        const live = requireLive(liveClient); const input = LiveSubmitWebInput.parse(args);
        if (input.variants !== undefined) {
          await live.submitWebVariants({ previewId: input.previewId, requestId: input.requestId, variants: input.variants as any });
        } else {
          await live.submitWebPreview({ previewId: input.previewId, requestId: input.requestId,
            domPreviewOps: (input.domPreviewOps ?? null) as any,
            candidateSourcePatch: (input.candidateSourcePatch ?? null) as any,
            baseFiles: (input.baseFiles ?? []) as any, status: "done" });
        }
        return ok("ok");
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
}
