import { createSupportCase } from "../cases/service.mjs";
import { scopeCaseToTenant } from "../tenancy/service.mjs";
import { createEmbedToken, findEmbedAccess, findProjectApiAccess, consumeEmbedToken } from "./keys.mjs";
import { getPublishedProjectContract } from "../contracts/catalog.mjs";

function bearer(req){const m=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i);return m?m[1].trim():"";}
function fail(message,status=401){const e=new Error(message);e.statusCode=status;throw e;}

export function createEmbeddedApiRouter({store,bodyFrom,json,caseContext,evidenceFor,createCaseDiagnostic}){
 async function apiAccess(req,scope){const access=findProjectApiAccess(await store.listProjects(),bearer(req),scope);if(!access)fail(`Project API key with ${scope} scope required.`);return access;}
 async function ownedCase(project,id){const record=await store.getCase(id);if(!record||record.projectId!==project.id||record.organizationId!==project.organizationId)fail("Case not found in API project scope.",404);return record;}

 return async function handleEmbedded(req,res,url){
  if(req.method==="POST"&&url.pathname==="/api/v1/embed-tokens"){const {project}=await apiAccess(req,"diagnostics:create");const payload=await bodyFrom(req);const result=createEmbedToken(project,payload);await store.putProject(result.project);return json(res,201,{token:result.credential,expiresAt:result.token.expiresAt}),true;}

  if(req.method==="POST"&&url.pathname==="/api/embed/diagnostics"){
   const access=findEmbedAccess(await store.listProjects(),bearer(req));if(!access)fail("Embed token is invalid, expired or already used.");
   const consumed=consumeEmbedToken(access.project,access.token.id);await store.putProject(consumed.project);
   let caseRecord=access.token.caseId?await ownedCase(access.project,access.token.caseId):null;
   if(!caseRecord){caseRecord=scopeCaseToTenant(createSupportCase({title:"Embedded connectivity diagnostic",customer:"Embedded support flow",affectedService:access.token.target}),access.project.organizationId,access.project.id);await store.putCase(caseRecord);}
   const payload={target:access.token.target,probeSelector:{scope:"public"},ttlMinutes:60};
   if(access.token.catalogContractId) payload.connectivityContract=getPublishedProjectContract(access.project,access.token.catalogContractId).contract;
   const result=await createCaseDiagnostic(caseRecord,payload);
   return json(res,201,{caseId:caseRecord.id,sessionId:result.created.session.id,invitation:result.created.credentials.invitationToken?`/diagnose#invite=${encodeURIComponent(result.created.credentials.invitationToken)}`:null}),true;
  }

  if(!url.pathname.startsWith("/api/v1/")) return false;

  if(req.method==="POST"&&url.pathname==="/api/v1/diagnostics"){
   const {project}=await apiAccess(req,"diagnostics:create"); const payload=await bodyFrom(req); let caseRecord;
   if(payload.caseId) caseRecord=await ownedCase(project,payload.caseId); else {caseRecord=scopeCaseToTenant(createSupportCase({title:payload.title||"API diagnostic",customer:payload.customer||"API client",affectedService:payload.affectedService||payload.target,severity:payload.severity}),project.organizationId,project.id);await store.putCase(caseRecord);}
   if(payload.catalogContractId) payload.connectivityContract=getPublishedProjectContract(project,payload.catalogContractId,payload.catalogContractVersion).contract;
   const result=await createCaseDiagnostic(caseRecord,{...payload,probeSelector:payload.probeSelector||{scope:"public"},ttlMinutes:payload.ttlMinutes||60});
   return json(res,201,{caseId:caseRecord.id,sessionId:result.created.session.id,invitation:result.created.credentials.invitationToken?`/diagnose#invite=${encodeURIComponent(result.created.credentials.invitationToken)}`:null}),true;
  }

  const diagnostic=url.pathname.match(/^\/api\/v1\/diagnostics\/([^/]+)$/);
  if(req.method==="GET"&&diagnostic){const {project}=await apiAccess(req,"diagnostics:read");const session=await store.getSession(decodeURIComponent(diagnostic[1]));if(!session?.caseId)fail("Diagnostic not found in project scope.",404);const caseRecord=await ownedCase(project,session.caseId);const run=await store.getRun(session.id);return json(res,200,{caseId:caseRecord.id,sessionId:session.id,status:run?.endpointMetrics?(run.remoteProbe?"complete":"endpoint-complete"):"pending",diagnosis:run?.diagnosis||null}),true;}

  const caseMatch=url.pathname.match(/^\/api\/v1\/cases\/([^/]+)(?:\/(evidence))?$/);
  if(caseMatch){const scope=caseMatch[2]?"evidence:read":"cases:read";const {project}=await apiAccess(req,scope);const caseRecord=await ownedCase(project,decodeURIComponent(caseMatch[1]));if(req.method==="GET"&&!caseMatch[2])return json(res,200,{...caseRecord,...await caseContext(caseRecord)}),true;if(req.method==="GET"&&caseMatch[2])return json(res,200,await evidenceFor(caseRecord,"network-identifiers")),true;}
  return false;
 };
}
