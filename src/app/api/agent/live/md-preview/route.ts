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
 // Batch md path: multiple proposals resolved in one agent reply. Kept fully
 // separate from the single-proposal `variants` path below (taken when absent).
 if(b.itemPreviews!==undefined){
  const rid=b.requestId; if(typeof rid!=="string")return NextResponse.json({error:"INVALID_PARAM",message:"requestId required"},{status:400});
  const list=b.itemPreviews; if(!Array.isArray(list)||list.length===0)return NextResponse.json({error:"INVALID_PARAM",message:"itemPreviews must be a non-empty array"},{status:400});
  const r=getRequest(rid); if(!r||r.workspaceId!==ws.id)return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
  // Validate ownership + shape for ALL entries before mutating any state.
  const parsed:Array<{previewId:string;variants:Array<{variantId?:string;label:string;markdown:string}>;path:string}>=[];
  for(const e of list){
   if(!e||typeof e!=="object")return NextResponse.json({error:"INVALID_PARAM"},{status:400});
   const entry=e as Record<string,unknown>; const pid=entry.previewId, rawV=entry.variants;
   if(typeof pid!=="string"||!Array.isArray(rawV)||rawV.length<2||rawV.length>5)return NextResponse.json({error:"INVALID_PARAM",message:"previewId, variants (2-5) required"},{status:400});
   const p=getProposal(pid); if(!p||p.workspaceId!==ws.id||p.requestId!==rid)return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
   const scope=enforceScope(auth.agent,{filePath:p.path,op:"mutate",workspaceId:ws.id}); if(!scope.ok)return NextResponse.json({error:scope.code,message:scope.message},{status:403});
   const variants=[] as Array<{variantId?:string;label:string;markdown:string}>;
   for(const x of rawV){if(!x||typeof x!=="object")return NextResponse.json({error:"INVALID_PARAM"},{status:400});const v=x as Record<string,unknown>;if((v.variantId!==undefined&&typeof v.variantId!=="string")||typeof v.label!=="string"||typeof v.markdown!=="string")return NextResponse.json({error:"INVALID_PARAM",message:"variants must contain data-only strings"},{status:400});variants.push({variantId:v.variantId as string|undefined,label:v.label,markdown:v.markdown});}
   parsed.push({previewId:pid,variants,path:p.path});
  }
  const items=[] as Array<{previewId:string;variants:number}>;
  for(const entry of parsed){const attached=attachVariants(entry.previewId,entry.variants);if(!attached)return NextResponse.json({error:"INVALID_STATE"},{status:409});items.push({previewId:entry.previewId,variants:attached.variants.length});}
  touchAgent(r.sessionId); markState(rid,"resolved");
  return NextResponse.json({ok:true,status:"preview-ready",requestId:rid,items});
 }
 const id=b.previewId, rid=b.requestId, raw=b.variants; if(typeof id!=="string"||typeof rid!=="string"||!Array.isArray(raw)||raw.length<2||raw.length>5)return NextResponse.json({error:"INVALID_PARAM",message:"previewId, requestId, variants (2-5) required"},{status:400});
 const p=getProposal(id), r=getRequest(rid); if(!p||p.workspaceId!==ws.id||!r||r.workspaceId!==ws.id||p.requestId!==rid)return NextResponse.json({error:"PREVIEW_NOT_FOUND"},{status:404});
 const scope=enforceScope(auth.agent,{filePath:p.path,op:"mutate",workspaceId:ws.id}); if(!scope.ok)return NextResponse.json({error:scope.code,message:scope.message},{status:403});
 touchAgent(r.sessionId);
 const variants=[] as Array<{variantId?:string;label:string;markdown:string}>;
 for(const x of raw){if(!x||typeof x!=="object")return NextResponse.json({error:"INVALID_PARAM"},{status:400});const v=x as Record<string,unknown>;if((v.variantId!==undefined&&typeof v.variantId!=="string")||typeof v.label!=="string"||typeof v.markdown!=="string")return NextResponse.json({error:"INVALID_PARAM",message:"variants must contain data-only strings"},{status:400});variants.push({variantId:v.variantId as string|undefined,label:v.label,markdown:v.markdown});}
 const attached=attachVariants(id,variants);if(!attached)return NextResponse.json({error:"INVALID_STATE"},{status:409}); markState(rid,"resolved"); return NextResponse.json({ok:true,status:"preview-ready",previewId:id,variants:attached.variants.length});
}
