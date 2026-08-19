import { createSupportCase, publicCase } from "../cases/service.mjs";
import { createOrganization, createProject, findOrganizationAccess, publicOrganization, publicProject, rotateOrganizationCredential, revokeOrganizationCredential, scopeCaseToTenant, assertTenantCase } from "./service.mjs";

function bearer(req){const match=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i);return match?match[1].trim():"";}
function fail(message,statusCode){const e=new Error(message);e.statusCode=statusCode;throw e;}

export function createTenantRouter({store,requireAdmin,bodyFrom,json,caseContext,evidenceFor,createCaseDiagnostic}){
  async function tenant(req){const org=findOrganizationAccess(await store.listOrganizations(),bearer(req));if(!org) fail("Organization credential required.",401);return org;}
  async function ownedProject(org,id){const project=await store.getProject(id);if(!project||project.organizationId!==org.id||project.enabled===false) fail("Project was not found in this organization.",404);return project;}

  return async function handleTenant(req,res,url){
    if(req.method==="POST"&&url.pathname==="/api/organizations"){requireAdmin(req);const payload=await bodyFrom(req);const created=createOrganization(payload);if((await store.listOrganizations()).some(item=>item.slug===created.organization.slug)) fail("Organization slug already exists.",409);await store.putOrganization(created.organization);const project=createProject(created.organization,{name:payload.defaultProject||"Default project"});await store.putProject(project);return json(res,201,{organization:publicOrganization(created.organization),credential:created.credential,defaultProject:publicProject(project)}),true;}
    if(req.method==="GET"&&url.pathname==="/api/organizations"){requireAdmin(req);return json(res,200,(await store.listOrganizations()).map(publicOrganization)),true;}
    const orgAction=url.pathname.match(/^\/api\/organizations\/([^/]+)\/(rotate|revoke)$/);
    if(orgAction){requireAdmin(req);const org=await store.getOrganization(decodeURIComponent(orgAction[1]));if(!org) fail("Organization not found.",404);if(req.method!=="POST") return false;if(orgAction[2]==="rotate"){const result=rotateOrganizationCredential(org);await store.putOrganization(result.organization);json(res,200,{organization:publicOrganization(result.organization),credential:result.credential});}else{const updated=revokeOrganizationCredential(org);await store.putOrganization(updated);json(res,200,publicOrganization(updated));}return true;}

    if(!url.pathname.startsWith("/api/tenant")) return false;
    const org=await tenant(req);
    if(req.method==="GET"&&url.pathname==="/api/tenant"){return json(res,200,{organization:publicOrganization(org),projects:(await store.listProjectsByOrganization(org.id)).map(publicProject)}),true;}
    if(req.method==="POST"&&url.pathname==="/api/tenant/projects"){const payload=await bodyFrom(req);const project=createProject(org,payload);if((await store.listProjectsByOrganization(org.id)).some(item=>item.slug===project.slug)) fail("Project slug already exists in this organization.",409);await store.putProject(project);return json(res,201,publicProject(project)),true;}
    if(req.method==="GET"&&url.pathname==="/api/tenant/projects"){return json(res,200,(await store.listProjectsByOrganization(org.id)).map(publicProject)),true;}

    if(req.method==="POST"&&url.pathname==="/api/tenant/cases"){const payload=await bodyFrom(req);const project=await ownedProject(org,String(payload.projectId||""));const caseRecord=scopeCaseToTenant(createSupportCase(payload),org.id,project.id);await store.putCase(caseRecord);return json(res,201,publicCase(caseRecord)),true;}
    if(req.method==="GET"&&url.pathname==="/api/tenant/cases"){const projectId=url.searchParams.get("projectId");if(projectId) await ownedProject(org,projectId);const cases=projectId?await store.listCasesByProject(projectId):await store.listCasesByOrganization(org.id);return json(res,200,await Promise.all(cases.map(async item=>publicCase(item,await caseContext(item))))),true;}

    const caseMatch=url.pathname.match(/^\/api\/tenant\/cases\/([^/]+)(?:\/(diagnostics|evidence))?$/);
    if(caseMatch){const caseRecord=assertTenantCase(await store.getCase(decodeURIComponent(caseMatch[1])),org);const action=caseMatch[2]||null;if(req.method==="GET"&&!action){return json(res,200,publicCase(caseRecord,await caseContext(caseRecord))),true;}if(req.method==="POST"&&action==="diagnostics"){const payload=await bodyFrom(req);const result=await createCaseDiagnostic(caseRecord,payload);return json(res,201,{case:publicCase(result.caseRecord,await caseContext(result.caseRecord)),session:result.created.session.id,invitation:result.created.credentials.invitationToken?`/diagnose#invite=${encodeURIComponent(result.created.credentials.invitationToken)}`:null}),true;}if(req.method==="GET"&&action==="evidence"){return json(res,200,await evidenceFor(caseRecord,"network-identifiers")),true;}}
    return false;
  };
}
