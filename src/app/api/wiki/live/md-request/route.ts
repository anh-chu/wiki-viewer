import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { readSnapshot } from "@/lib/proof/ops-applier";
import { getOrCreateSession, enqueueRequest } from "@/lib/proof/live/store";
import { createProposal, bindRequest } from "@/lib/proof/live/md-proposal-store";
import { createHash } from "node:crypto";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<NextResponse> {
  const csrf = checkOrigin(req); if (csrf) return csrf;
  const ctx = await resolveWorkspaceForUser(req, "write"); if (!ctx.ok) return NextResponse.json({error:ctx.code},{status:ctx.status});
  let b: Record<string, unknown>; try { b = await req.json() as Record<string, unknown>; } catch { return NextResponse.json({error:"INVALID_JSON"},{status:400}); }
  const path = b.path, blockRef = b.blockRef, instruction = b.instruction;
  if (typeof path !== "string" || typeof blockRef !== "string" || typeof instruction !== "string" || !instruction.trim() || typeof b.baseRevision !== "number") return NextResponse.json({error:"INVALID_PARAM",message:"path, blockRef, baseRevision, instruction required"},{status:400});
  const rp = await resolveWorkspacePath(ctx.ws.rootDir, path, { allowMissing: true });
  if (!rp) return NextResponse.json({error:"INVALID_PATH"},{status:400});
  const relPath = rp.relPath;
  const snapshot = await readSnapshot(ctx.ws.rootDir, relPath);
  const block = snapshot?.blocks.find((item) => item.ref === blockRef);
  if (!block) return NextResponse.json({error:"BLOCK_NOT_FOUND"},{status:400});
  const baseBlockHash = `sha256:${createHash("sha256").update(block.markdown,"utf8").digest("hex")}`;
  const session = getOrCreateSession(ctx.ws.id);
  const proposal = createProposal({workspaceId:ctx.ws.id,path:relPath,blockRef,baseRevision:b.baseRevision,baseBlockHash});
  const enq = enqueueRequest({sessionId:session.id,workspaceId:ctx.ws.id,path:relPath,blockRef,baseRevision:b.baseRevision,kind:"generate",previewId:proposal.previewId,instruction,selectionText:typeof b.selectionText === "string" ? b.selectionText : null,selectionStart:typeof b.selectionStart === "number" ? b.selectionStart : null,selectionEnd:typeof b.selectionEnd === "number" ? b.selectionEnd : null});
  if (!enq.ok) return NextResponse.json({error:enq.code,outstandingRequestId:enq.request.id},{status:409});
  bindRequest(proposal.previewId,enq.request.id);
  return NextResponse.json({previewId:proposal.previewId,requestId:enq.request.id});
}
