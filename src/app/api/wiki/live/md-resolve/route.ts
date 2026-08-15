import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { claimForResolve, getProposal, markResolved, releaseClaim } from "@/lib/proof/live/md-proposal-store";
import { readSnapshot } from "@/lib/proof/ops-applier";
import { applyOps } from "@/lib/proof/ops-applier";
import { createHash } from "node:crypto";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<NextResponse> {
  const csrf=checkOrigin(req); if(csrf)return csrf;
  const ctx=await resolveWorkspaceForUser(req,"write"); if(!ctx.ok)return NextResponse.json({error:ctx.code},{status:ctx.status});
  let b: Record<string,unknown>; try{b=await req.json() as Record<string,unknown>}catch{return NextResponse.json({error:"INVALID_JSON"},{status:400})}
  const id=b.previewId, action=b.action; if(typeof id!=="string"||(action!=="accept"&&action!=="discard"))return NextResponse.json({error:"INVALID_PARAM"},{status:400});
  const p=getProposal(id); if(!p||p.workspaceId!==ctx.ws.id)return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
  if(!claimForResolve(id))return NextResponse.json({error:"INVALID_STATE"},{status:409});
  if(action==="discard"){markResolved(id,"discarded");return NextResponse.json({ok:true,status:"discarded"});}
  const vId=typeof b.variantId==="string"?b.variantId:null; const v=p.variants.find(v=>v.variantId===vId);
  if(!v){releaseClaim(id);return NextResponse.json({error:"INVALID_PARAM",message:"valid variantId required"},{status:400});}
  const rp=await resolveWorkspacePath(ctx.ws.rootDir,p.path,{allowMissing:true}); if(!rp){markResolved(id,"invalidated");return NextResponse.json({error:"INVALID_PATH"},{status:400});}
  const snap=await readSnapshot(ctx.ws.rootDir,rp.relPath); const block=snap?.blocks.find(x=>x.ref===p.blockRef);
  const hash=block?`sha256:${createHash("sha256").update(block.markdown,"utf8").digest("hex")}`:null;
  if(!snap||!block||hash!==p.baseBlockHash){markResolved(id,"invalidated");return NextResponse.json({error:"BASE_DRIFT"},{status:409});}
  const result=await applyOps({rootDir:ctx.ws.rootDir,mdPath:rp.relPath,baseRevision:p.baseRevision,by:"human",ops:[{type:"block.replace",ref:p.blockRef,markdown:v.markdown}]});
  if(!result.ok){markResolved(id,"invalidated");return NextResponse.json({error:result.code},{status:result.status});}
  markResolved(id,"accepted",v.variantId); return NextResponse.json({ok:true,status:"accepted"});
}
