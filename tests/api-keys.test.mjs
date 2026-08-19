import test from "node:test";
import assert from "node:assert/strict";
import { createProjectApiKey, findProjectApiAccess, revokeProjectApiKey, createEmbedToken, findEmbedAccess, consumeEmbedToken } from "../src/api/keys.mjs";

const project={id:"PRJ-1",organizationId:"ORG-1",name:"Support"};

test("project API keys enforce explicit scopes and never expose stored raw credentials",()=>{
 const created=createProjectApiKey(project,{name:"widget",scopes:["diagnostics:create","diagnostics:read"]});
 assert.match(created.credential,/^fl_api_/); assert.equal(JSON.stringify(created.project).includes(created.credential),false);
 assert.equal(findProjectApiAccess([created.project],created.credential,"diagnostics:create").project.id,"PRJ-1");
 assert.equal(findProjectApiAccess([created.project],created.credential,"evidence:read"),null);
 const revoked=revokeProjectApiKey(created.project,created.apiKey.id); assert.equal(findProjectApiAccess([revoked],created.credential,"diagnostics:create"),null);
});

test("embed token is target-scoped, expiring and one-use",()=>{
 const created=createEmbedToken(project,{target:"https://example.com/health",ttlMinutes:5},Date.parse("2026-08-19T00:00:00Z"));
 assert.match(created.credential,/^fl_embed_/);
 const access=findEmbedAccess([created.project],created.credential,Date.parse("2026-08-19T00:01:00Z")); assert.equal(access.token.target,"https://example.com/health");
 const consumed=consumeEmbedToken(created.project,access.token.id,Date.parse("2026-08-19T00:02:00Z"));
 assert.equal(findEmbedAccess([consumed.project],created.credential,Date.parse("2026-08-19T00:03:00Z")),null);
 assert.equal(findEmbedAccess([created.project],created.credential,Date.parse("2026-08-19T00:06:00Z")),null);
});

test("rejects unsupported API scopes",()=>{assert.throws(()=>createProjectApiKey(project,{scopes:["admin:everything"]}),/Unsupported API key scope/);});
