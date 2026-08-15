import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getProposal } from "@/lib/proof/live/md-proposal-store";
export const runtime = "nodejs";
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = await resolveWorkspaceForUser(req,"read"); if (!ctx.ok) return NextResponse.json({error:ctx.code},{status:ctx.status});
  const id = new URL(req.url).searchParams.get("previewId"); if (!id) return NextResponse.json({error:"INVALID_PARAM"},{status:400});
  const p = getProposal(id); if (!p || p.workspaceId !== ctx.ws.id) return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
  return NextResponse.json({state:p.state,variants:p.variants,selectedVariantId:p.selectedVariantId,path:p.path,blockRef:p.blockRef});
}
