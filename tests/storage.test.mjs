import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/storage/store.mjs";

test("persists diagnostic, case and tenant collections across store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-store-")); const file = join(dir, "faultline.json");
  try {
    const first=createStore(file);
    await first.putOrganization({id:"ORG-TEST",name:"Northstar",slug:"northstar"});
    await first.putProject({id:"PRJ-TEST",organizationId:"ORG-TEST",name:"Default",slug:"default"});
    await first.putSession({id:"FL-TEST",caseId:"CASE-TEST",target:{input:"example.com",port:443}});
    await first.putRun({id:"FL-TEST",sessionId:"FL-TEST",updatedAt:"2026-08-18T18:00:00.000Z",metrics:{targetReachable:true}});
    await first.putProbe({id:"PRB-TEST",name:"london-1",tokenHash:"hash",enabled:true});
    await first.putCase({id:"CASE-TEST",organizationId:"ORG-TEST",projectId:"PRJ-TEST",title:"Test case",createdAt:"2026-08-18T17:00:00.000Z",updatedAt:"2026-08-18T18:02:00.000Z",sessionIds:["FL-TEST"]});
    await first.appendAudit({at:"2026-08-18T18:01:00.000Z",type:"probe.registered",probeId:"PRB-TEST"});
    const second=createStore(file);
    assert.equal((await second.getOrganization("ORG-TEST")).slug,"northstar");
    assert.equal((await second.getProject("PRJ-TEST")).organizationId,"ORG-TEST");
    assert.equal((await second.listCasesByOrganization("ORG-TEST")).length,1);
    assert.equal((await second.listCasesByProject("PRJ-TEST")).length,1);
    assert.equal((await second.listSessionsByCase("CASE-TEST")).length,1);
    const raw=JSON.parse(await readFile(file,"utf8"));
    assert.equal(raw.version,5); assert.equal(raw.organizations.length,1); assert.equal(raw.projects.length,1); assert.equal(raw.cases.length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("migrates old state by adding tenant collections", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try { await writeFile(file,JSON.stringify({version:2,sessions:[],runs:[],probes:[{id:"PRB-OLD",name:"old"}]})); const store=createStore(file); assert.equal((await store.getProbe("PRB-OLD")).name,"old"); assert.deepEqual(await store.listOrganizations(),[]); assert.deepEqual(await store.listProjects(),[]); await store.appendAudit({at:"2026-08-18T18:00:00.000Z",type:"migration.test"}); const raw=JSON.parse(await readFile(file,"utf8")); assert.equal(raw.version,5); }
  finally { await rm(dir,{recursive:true,force:true}); }
});

test("replaces existing records instead of duplicating ids", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
 try {const store=createStore(file); await store.putRun({id:"FL-TEST",updatedAt:"2026-08-18T18:00:00Z",source:"agent"}); await store.putRun({id:"FL-TEST",updatedAt:"2026-08-18T18:01:00Z",source:"correlated"}); await store.putOrganization({id:"ORG-X",name:"Before"}); await store.putOrganization({id:"ORG-X",name:"After"}); assert.equal((await store.listRuns()).length,1); assert.equal((await store.listOrganizations()).length,1); assert.equal((await store.getOrganization("ORG-X")).name,"After");}
 finally{await rm(dir,{recursive:true,force:true});}
});
