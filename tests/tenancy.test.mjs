import test from "node:test";
import assert from "node:assert/strict";
import { createSupportCase } from "../src/cases/service.mjs";
import { createOrganization, createProject, findOrganizationAccess, rotateOrganizationCredential, revokeOrganizationCredential, scopeCaseToTenant, assertTenantCase } from "../src/tenancy/service.mjs";

test("organization credentials are opaque, hashed and rotatable",()=>{
 const first=createOrganization({name:"Northstar Design",slug:"northstar"});
 assert.match(first.credential,/^fl_org_/); assert.equal(first.organization.credentialHash.includes(first.credential),false);
 assert.equal(findOrganizationAccess([first.organization],first.credential).id,first.organization.id);
 const rotated=rotateOrganizationCredential(first.organization); assert.equal(findOrganizationAccess([rotated.organization],first.credential),null); assert.equal(findOrganizationAccess([rotated.organization],rotated.credential).id,first.organization.id);
 const revoked=revokeOrganizationCredential(rotated.organization); assert.equal(findOrganizationAccess([revoked],rotated.credential),null);
});

test("projects and cases remain scoped to one organization",()=>{
 const a=createOrganization({name:"A"}).organization; const b=createOrganization({name:"B"}).organization;
 const pa=createProject(a,{name:"Support"}); const pb=createProject(b,{name:"Support"});
 const caseA=scopeCaseToTenant(createSupportCase({title:"A case"}),a.id,pa.id);
 assert.equal(assertTenantCase(caseA,a,pa).title,"A case");
 assert.throws(()=>assertTenantCase(caseA,b,pb),/not found in this tenant scope/);
});
