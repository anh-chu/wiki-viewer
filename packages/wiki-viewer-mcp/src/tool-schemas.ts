/**
 * Zod schemas for the seven MCP filesystem tools.
 *
 * JSON Schema conversion uses only the public `z.toJSONSchema()` API from Zod v4.
 * No private `_def` access.
 */

import * as z from "zod";

export const ReadFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  range: z.string().optional().describe("HTTP Range header value, e.g. 'bytes=0-1023'"),
});

export const WriteFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  content: z.string().describe("File content (text)"),
  mkdirs: z.boolean().optional().describe("Create parent directories if missing"),
  force: z.boolean().optional().describe("Skip If-Match guard (audited)"),
  ifCollabMatch: z.number().optional().describe("If-Collab-Match revision (for tracked .md)"),
});

export const EditFileInput = z.object({
  path: z.string().describe("File path relative to wiki root"),
  find: z.string().describe("Exact string to find (first occurrence)"),
  replace: z.string().describe("Replacement string"),
});

export const ListDirectoryInput = z.object({
  path: z.string().describe("Directory path relative to wiki root"),
  recursive: z.boolean().optional().describe("List recursively"),
  depth: z.number().optional().describe("Max depth for recursive listing"),
  limit: z.number().optional().describe("Max entries to return"),
});

export const SearchInput = z.object({
  kind: z.enum(["grep", "glob"]).describe("grep = text search, glob = path pattern"),
  query: z.string().describe("Search query or glob pattern"),
  path: z.string().optional().describe("Root path to search within"),
  glob: z.string().optional().describe("File glob filter for grep"),
  limit: z.number().optional().describe("Max matches to return"),
});

export const MoveFileInput = z.object({
  from: z.string().describe("Source path"),
  to: z.string().describe("Destination path"),
});

export const DeleteFileInput = z.object({
  path: z.string().describe("File path to delete"),
  recursive: z.boolean().optional().describe("Delete directory recursively"),
  force: z.boolean().optional().describe("Skip If-Match guard (audited)"),
});

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toInputSchema(schema: z.ZodObject<Record<string, z.ZodTypeAny>>): Record<string, unknown> {
  return z.toJSONSchema(schema);
}

export const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a file from the wiki-viewer instance. Returns content and metadata. " +
      "Captures sha256 (ETag) and X-Collab-State for subsequent writes. " +
      "Always read before writing to get the current sha.",
    inputSchema: toInputSchema(ReadFileInput),
  },
  {
    name: "write_file",
    description:
      "Write (create or overwrite) a file. " +
      "If you have previously read the file, the last known sha is sent as If-Match automatically — " +
      "you get a 412 error if the file changed since your read. " +
      "WARNING: for .md files with X-Collab-State 'active', raw writes are blocked — " +
      "use wiki-viewer block-ops (Tier 2) instead so the human can review your changes.",
    inputSchema: toInputSchema(WriteFileInput),
  },
  {
    name: "edit_file",
    description:
      "Edit a file by exact string replacement (first occurrence). " +
      "Implemented client-side as: read → str-replace → PUT with If-Match. " +
      "Returns an error if the find string is not found or the file is collab-active. " +
      "For .md files, prefer block-ops if X-Collab-State is 'active'.",
    inputSchema: toInputSchema(EditFileInput),
  },
  {
    name: "list_directory",
    description: "List directory contents. Scope-filtered; .proof/ is hidden.",
    inputSchema: toInputSchema(ListDirectoryInput),
  },
  {
    name: "search",
    description:
      "Search files. kind='grep' searches file contents; kind='glob' matches paths. " +
      "Server-side — avoids round-trip explosion from ls+read patterns.",
    inputSchema: toInputSchema(SearchInput),
  },
  {
    name: "move_file",
    description:
      "Move or rename a file. Sidecar (.proof/*.json) is moved automatically for .md files.",
    inputSchema: toInputSchema(MoveFileInput),
  },
  {
    name: "delete_file",
    description:
      "Delete a file. Requires 'delete' scope. You must have read the file first " +
      "(its sha is sent as If-Match). .md sidecars are removed automatically.",
    inputSchema: toInputSchema(DeleteFileInput),
  },
] as const satisfies ToolDefinition[];
