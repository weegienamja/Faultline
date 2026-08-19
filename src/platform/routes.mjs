import {
  addCaseNote,
  attachSessionToCase,
  createSupportCase,
  publicCase,
  recordCaseEvent,
  updateSupportCase
} from "../cases/service.mjs";
import { buildCaseEvidencePackage, redactCaseEvidence, renderEvidenceHtml } from "../cases/evidence.mjs";
import { addParticipantContribution, createCaseParticipantInvitation, findParticipantAccess, publicParticipant, revokeCaseParticipant, sharedCaseView, touchParticipant } from "../cases/participants.mjs";
import { createTenantRouter } from "../tenancy/routes.mjs";
import { createEmbeddedApiRouter } from "../api/routes.mjs";

function notFound(message){const error=new Error(message);error.statusCode=404;throw error;}
function unauthorized(message="Case-room participant credential required."){const error=new Error(message);error.statusCode=401;throw error;}
function bearer(req){const match=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i);return match?match[1].trim():"";}
function safeFilename(value){return String(value||"faultline-case").replace(/[^a-z0-9._-]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,100)||"faultline-case";}

export function createPlatformRouter({store,requireAdmin,bodyFrom,json,createSession,publicSession}){
 async function getCase(id){const record=await store.getCase(id);if(!record)notFound(`Support case ${id} was not found.`);return record;}
 async function caseContext(record){const sessions=await store.listSessionsByCase(record.id);const runs=await store.listRunsForSessions(record.sessionIds||[]);return {sessions,runs};}
 async function evidenceFor(record,redaction="none"){const built=buildCaseEvidencePackage(record,await caseContext(record));return redaction&&redaction!=="none"?redactCaseEvidence(built,redaction):built;}
 async function createCaseDiagnostic(record,payload){const created=await createSession({...payload,caseId:record.id,customer:payload.customer||record.customer,title:payload.title||`${record.title} · diagnostic`,ephemeral:payload.ephemeral!==false});const updated=attachSessionToCase(record,created.session.id);await store.putCase(updated);return {created,caseRecord:updated};}

 const handleTenant=createTenantRouter({store,requireAdmin,bodyFrom,json,caseContext,evidenceFor,createCaseDiagnostic});
 const handleEmbedded=createEmbeddedApiRouter({store,bodyFrom,json,caseContext,evidenceFor,createCaseDiagnostic});

 async function participantContext(req){const access=findParticipantAccess(await store.listCases(),bearer(req));if(!access)unauthorized("Case-room credential is invalid, expired or revoked.");const touched=touchParticipant(access.caseRecord,access.invitation.id);await store.putCase(touched);return {caseRecord:touched,invitation:touched.participantInvitations.find(item=>item.id===access.invitation.id)};}
 async function handleParticipantRoom(req,res,url){if(!url.pathname.startsWith("/api/case-room"))return false;const {caseRecord,invitation}=await participantContext(req);if(req.method==="GET"&&url.pathname==="/api/case-room"){json(res,200,{participant:publicParticipant(invitation),case:sharedCaseView(caseRecord,await evidenceFor(caseRecord,"network-identifiers"))});return true;}if(req.method==="POST"&&url.pathname==="/api/case-room/contributions"){const result=addParticipantContribution(caseRecord,invitation,await bodyFrom(req));await store.putCase(result.caseRecord);json(res,201,{contribution:result.contribution,case:sharedCaseView(result.caseRecord,await evidenceFor(result.caseRecord,"network-identifiers"))});return true;}return false;}

 async function handle(req,res,url){
  if(await handleParticipantRoom(req,res,url))return true;
  if(await handleEmbedded(req,res,url))return true;
  if(await handleTenant(req,res,url))return true;
  if(!url.pathname.startsWith("/api/cases"))return false;
  requireAdmin(req);
  if(req.method==="POST"&&url.pathname==="/api/cases"){const record=createSupportCase(await bodyFrom(req));await store.putCase(record);await store.appendAudit({at:new Date().toISOString(),type:"case.created",probeId:null,details:{caseId:record.id,severity:record.severity}});json(res,201,publicCase(record));return true;}
  if(req.method==="GET"&&url.pathname==="/api/cases"){const cases=await store.listCases(),sessions=await store.listSessions(),runs=await store.listRuns(5000);json(res,200,cases.map(record=>({...publicCase(record,{sessions:sessions.filter(s=>s.caseId===record.id),runs:runs.filter(r=>(record.sessionIds||[]).includes(r.sessionId||r.id))}),participants:(record.participantInvitations||[]).map(publicParticipant),contributionCount:(record.contributions||[]).length})));return true;}
  const revoke=url.pathname.match(/^\/api\/cases\/([^/]+)\/participants\/([^/]+)\/revoke$/);if(req.method==="POST"&&revoke){const record=await getCase(decodeURIComponent(revoke[1]));const updated=revokeCaseParticipant(record,decodeURIComponent(revoke[2]));await store.putCase(updated);json(res,200,{participants:(updated.participantInvitations||[]).map(publicParticipant)});return true;}
  const match=url.pathname.match(/^\/api\/cases\/([^/]+)(?:\/(notes|diagnostics|evidence|report|compare|participants|contributions))?$/);if(!match)return false;const record=await getCase(decodeURIComponent(match[1]));const action=match[2]||null;
  if(req.method==="GET"&&!action){json(res,200,{...publicCase(record,await caseContext(record)),participants:(record.participantInvitations||[]).map(publicParticipant),contributions:structuredClone(record.contributions||[])});return true;}
  if(req.method==="PATCH"&&!action){const updated=updateSupportCase(record,await bodyFrom(req));await store.putCase(updated);json(res,200,publicCase(updated,await caseContext(updated)));return true;}
  if(req.method==="POST"&&action==="notes"){const result=addCaseNote(record,await bodyFrom(req));await store.putCase(result.caseRecord);json(res,201,{note:result.note,case:publicCase(result.caseRecord,await caseContext(result.caseRecord))});return true;}
  if(req.method==="POST"&&action==="participants"){const result=createCaseParticipantInvitation(record,await bodyFrom(req));await store.putCase(result.caseRecord);json(res,201,{participant:result.invitation,credential:result.token,roomPath:`/case-room#token=${encodeURIComponent(result.token)}`});return true;}
  if(req.method==="GET"&&action==="participants"){json(res,200,(record.participantInvitations||[]).map(publicParticipant));return true;}
  if(req.method==="GET"&&action==="contributions"){json(res,200,structuredClone(record.contributions||[]));return true;}
  if(req.method==="POST"&&action==="diagnostics"){const result=await createCaseDiagnostic(record,await bodyFrom(req));json(res,201,{case:publicCase(result.caseRecord,await caseContext(result.caseRecord)),session:publicSession(result.created.session),credentials:result.created.credentials,invitation:result.created.credentials.invitationToken?{path:`/diagnose#invite=${encodeURIComponent(result.created.credentials.invitationToken)}`}:null});return true;}
  if(req.method==="GET"&&action==="evidence"){const packageData=await evidenceFor(record,url.searchParams.get("redaction")||"none");res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","content-disposition":`attachment; filename="${safeFilename(record.id)}-evidence.json"`});res.end(`${JSON.stringify(packageData,null,2)}\n`);return true;}
  if(req.method==="GET"&&action==="report"){const packageData=await evidenceFor(record,url.searchParams.get("redaction")||"none");res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-disposition":`inline; filename="${safeFilename(record.id)}-evidence.html"`});res.end(renderEvidenceHtml(packageData));return true;}
  if(req.method==="GET"&&action==="compare"){json(res,200,(await evidenceFor(record,"none")).comparison);return true;}
  return false;
 }
 async function recordSessionEvidence(session,type,{summary,evidenceKind="observed",metadata=null}={}){if(!session?.caseId)return null;const record=await store.getCase(session.caseId);if(!record)return null;if((record.timeline||[]).some(event=>event.type===type&&event.sessionId===session.id))return record;const updated=recordCaseEvent(record,{type,sessionId:session.id,actor:"faultline",source:"diagnostic",summary:summary||`${type} received for ${session.id}.`,evidenceKind,metadata});await store.putCase(updated);return updated;}
 return {handle,recordSessionEvidence,evidenceFor};
}
