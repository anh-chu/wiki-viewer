import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { getProposal, attachVariants } from "@/lib/proof/live/md-proposal-store";
import { getRequest, markState, touchAgent } from "@/lib/proof/live/store";
export const runtime="nodejs";
export async function POST(req:Request):Promise<NextResponse>{
 const auth=await checkAuth(req); if(!auth.ok)return NextResponse.json({error:"UNAUTHORIZED"},{status:401});
 const wsx=await resolveWorkspaceForAgent(req); if(!wsx.ok)return NextResponse.json({error:wsx.code},{status:wsx.status}); const {ws}=wsx;
 let b:Record<string,unknown>;try{b=await req.json() as Record<string,unknown>}catch{return NextResponse.json({error:"INVALID_JSON"},{status:400})}
 const id=b.previewId, rid=b.requestId, raw=b.variants; if(typeof id!=="string"||typeof rid!=="string"||!Array.isArray(raw)||raw.length<2||raw.length>5)return NextResponse.json({error:"INVALID_PARAM",message:"previewId, requestId, variants (2-5) required"},{status:400});
 const p=getProposal(id), r=getRequest(rid); if(!p||p.workspaceId!==ws.id||!r||r.workspaceId!==ws.id||p.requestId!==rid)return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
 const scope=enforceScope(auth.agent,{filePath:p.path,op:"mutate",workspaceId:ws.id}); if(!scope.ok)return NextResponse.json({error:scope.code,message:scope.message},{status:403});
 touchAgent(r.sessionId);
 const variants=[] as Array<{variantId?:string;label:string;markdown:string}>;
 for(const x of raw){if(!x||typeof x!=="object")return NextResponse.json({error:"INVALID_PARAM"},{status:400});const v=x as Record<string,unknown>;if((v.variantId!==undefined&&typeof v.variantId!=="string")||typeof v.label!=="string"||typeof v.markdown!=="string")return NextResponse.json({error:"INVALID_PARAM",message:"variants must contain data-only strings"},{status:400});variants.push({variantId:v.variantId as string|undefined,label:v.label,markdown:v.markdown});}
 const attached=attachVariants(id,variants);if(!attached)return NextResponse.json({error:"INVALID_STATE"},{status:409}); markState(rid,"resolved"); return NextResponse.json({ok:true,status:"preview-ready",previewId:id,variants:attached.variants.length});
}
