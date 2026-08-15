import Database from "@/lib/sqlite";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export type MdProposalState = "requested" | "ready" | "resolving" | "accepted" | "discarded" | "invalidated";
export interface MdVariant { variantId: string; label: string; markdown: string }
export interface MdProposal {
  previewId: string; workspaceId: string; path: string; blockRef: string;
  baseRevision: number; baseBlockHash: string; requestId: string | null;
  state: MdProposalState; variants: MdVariant[]; selectedVariantId: string | null;
  createdAt: number; resolvedAt: number | null;
}
let db: InstanceType<typeof Database> | null = null;
function getDb() {
  if (db) return db;
  const dir = path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
  mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, "live.db"));
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL");
  db.exec(`CREATE TABLE IF NOT EXISTS md_proposal (
    previewId TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    block_ref TEXT NOT NULL, base_revision INTEGER NOT NULL, base_block_hash TEXT NOT NULL,
    request_id TEXT, state TEXT NOT NULL, variants TEXT NOT NULL,
    selected_variant_id TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
  ); CREATE INDEX IF NOT EXISTS md_proposal_ws_idx ON md_proposal(workspace_id);`);
  return db;
}
function id() { return `mdp_${randomBytes(9).toString("base64url")}`; }
function map(r: Record<string, unknown>): MdProposal { return {
  previewId: r.previewId as string, workspaceId: r.workspace_id as string, path: r.path as string,
  blockRef: r.block_ref as string, baseRevision: r.base_revision as number, baseBlockHash: r.base_block_hash as string,
  requestId: r.request_id as string | null, state: r.state as MdProposalState,
  variants: JSON.parse((r.variants as string) || "[]") as MdVariant[], selectedVariantId: r.selected_variant_id as string | null,
  createdAt: r.created_at as number, resolvedAt: r.resolved_at as number | null,
}; }
export function createProposal(input: { workspaceId: string; path: string; blockRef: string; baseRevision: number; baseBlockHash: string; requestId?: string | null }): MdProposal {
  const previewId = id(), now = Date.now();
  getDb().prepare(`INSERT INTO md_proposal (previewId,workspace_id,path,block_ref,base_revision,base_block_hash,request_id,state,variants,selected_variant_id,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,'requested','[]',NULL,?,NULL)`).run(previewId,input.workspaceId,input.path,input.blockRef,input.baseRevision,input.baseBlockHash,input.requestId ?? null,now);
  return getProposal(previewId)!;
}
export function bindRequest(previewId: string, requestId: string): void { getDb().prepare(`UPDATE md_proposal SET request_id=? WHERE previewId=?`).run(requestId, previewId); }
export function attachVariants(previewId: string, variants: Array<{variantId?: string; label: string; markdown: string}>): MdProposal | null {
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 5) return null;
  const ids = new Set<string>(); const out: MdVariant[] = [];
  for (const v of variants) { if (!v || typeof v.label !== "string" || typeof v.markdown !== "string" || (v.variantId !== undefined && typeof v.variantId !== "string")) return null; const variantId = v.variantId || `v_${createHash("sha256").update(`${v.label}\0${v.markdown}`).digest("hex").slice(0,12)}`; if (ids.has(variantId)) return null; ids.add(variantId); out.push({ variantId, label: v.label, markdown: v.markdown }); }
  const result = getDb().prepare(`UPDATE md_proposal SET variants=?, state='ready' WHERE previewId=? AND state='requested'`).run(JSON.stringify(out),previewId);
  return result.changes ? getProposal(previewId) : null;
}
export function getProposal(previewId: string): MdProposal | null { const r = getDb().prepare(`SELECT * FROM md_proposal WHERE previewId=?`).get(previewId) as Record<string, unknown> | undefined; return r ? map(r) : null; }
export function claimForResolve(previewId: string): MdProposal | null { const r = getDb().prepare(`UPDATE md_proposal SET state='resolving' WHERE previewId=? AND state='ready'`).run(previewId); return r.changes ? getProposal(previewId) : null; }
export function releaseClaim(previewId: string): MdProposal | null { const r = getDb().prepare(`UPDATE md_proposal SET state='ready' WHERE previewId=? AND state='resolving'`).run(previewId); return r.changes ? getProposal(previewId) : null; }
export function markResolved(previewId: string, state: "accepted" | "discarded" | "invalidated", selectedVariantId?: string | null): MdProposal | null { const r = getDb().prepare(`UPDATE md_proposal SET state=?, selected_variant_id=COALESCE(?, selected_variant_id), resolved_at=? WHERE previewId=? AND state='resolving'`).run(state,selectedVariantId ?? null,Date.now(),previewId); return r.changes ? getProposal(previewId) : null; }
export function _resetForTests(): void { if (db) { db.close(); db = null; } }