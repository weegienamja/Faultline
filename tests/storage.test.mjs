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
    assert.equal(raw.version,7); assert.equal(raw.organizations.length,1); assert.equal(raw.projects.length,1); assert.equal(raw.cases.length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("migrates old state by adding tenant collections", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try { await writeFile(file,JSON.stringify({version:2,sessions:[],runs:[],probes:[{id:"PRB-OLD",name:"old"}]})); const store=createStore(file); assert.equal((await store.getProbe("PRB-OLD")).name,"old"); assert.deepEqual(await store.listOrganizations(),[]); assert.deepEqual(await store.listProjects(),[]); await store.appendAudit({at:"2026-08-18T18:00:00.000Z",type:"migration.test"}); const raw=JSON.parse(await readFile(file,"utf8")); assert.equal(raw.version,7); assert.deepEqual(raw.incidents,[], "a v2 file gains an empty incidents collection"); }
  finally { await rm(dir,{recursive:true,force:true}); }
});

test("replaces existing records instead of duplicating ids", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
 try {const store=createStore(file); await store.putRun({id:"FL-TEST",updatedAt:"2026-08-18T18:00:00Z",source:"agent"}); await store.putRun({id:"FL-TEST",updatedAt:"2026-08-18T18:01:00Z",source:"correlated"}); await store.putOrganization({id:"ORG-X",name:"Before"}); await store.putOrganization({id:"ORG-X",name:"After"}); assert.equal((await store.listRuns()).length,1); assert.equal((await store.listOrganizations()).length,1); assert.equal((await store.getOrganization("ORG-X")).name,"After");}
 finally{await rm(dir,{recursive:true,force:true});}
});

test("persists a closed Flight Recorder incident across store instances", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try {
    const store=createStore(file);
    await store.putIncident({ id:"FLR-2026-0001", schema:"faultline.flight-recorder-incident", target:{host:"api.example.com"}, observedChange:{ classification:"temporal_association" } });
    // A fresh instance reads the same file: this is the restart path.
    const reopened=createStore(file);
    const restored=await reopened.getIncident("FLR-2026-0001");
    assert.equal(restored.id,"FLR-2026-0001");
    assert.equal(restored.observedChange.classification,"temporal_association","provenance must survive the round trip");
    assert.equal((await reopened.listIncidents()).length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("retained incidents are bounded on disk", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try {
    const store=createStore(file);
    for (let index=0; index<30; index+=1) await store.putIncident({ id:`FLR-2026-${String(index).padStart(4,"0")}` }, { max: 5 });
    assert.equal((await store.listIncidents()).length,5);
    // Newest kept.
    assert.equal((await store.listIncidents())[0].id,"FLR-2026-0029");
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("an incident can be deleted", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try {
    const store=createStore(file);
    await store.putIncident({ id:"FLR-2026-0001" });
    // Reports what it removed, including any evidence attached to the incident.
    assert.deepEqual(await store.deleteIncident("FLR-2026-0001"),{ removed:true, attachmentsRemoved:0 });
    assert.equal(await store.getIncident("FLR-2026-0001"),null);
    assert.deepEqual(await store.deleteIncident("FLR-2026-0001"),{ removed:false, attachmentsRemoved:0 });
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("incident evidence is stored separately and survives a reopen", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try {
    const store=createStore(file);
    await store.putIncident({ id:"FLR-2026-0007" });
    await store.putIncidentEvidence({ id:"FLE-AAA", incidentId:"FLR-2026-0007", kind:"network-bisect", createdAt:"2026-08-19T20:00:00.000Z" });
    await store.putIncidentEvidence({ id:"FLE-BBB", incidentId:"FLR-2026-0007", kind:"network-bisect", createdAt:"2026-08-19T20:05:00.000Z" });
    await store.putIncidentEvidence({ id:"FLE-CCC", incidentId:"FLR-2026-0008", kind:"network-bisect", createdAt:"2026-08-19T20:00:00.000Z" });

    const reopened=createStore(file);
    const attached=await reopened.listIncidentEvidence("FLR-2026-0007");
    assert.deepEqual(attached.map(e=>e.id),["FLE-AAA","FLE-BBB"],"oldest first, scoped to the incident");
    assert.equal((await reopened.getIncidentEvidence("FLE-CCC")).incidentId,"FLR-2026-0008");
    // The frozen incident is untouched by attaching evidence to it.
    assert.deepEqual(await reopened.getIncident("FLR-2026-0007"),{ id:"FLR-2026-0007" });
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("deleting an incident removes its evidence attachments", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"faultline-store-")); const file=join(dir,"faultline.json");
  try {
    const store=createStore(file);
    await store.putIncident({ id:"FLR-2026-0007" });
    await store.putIncidentEvidence({ id:"FLE-AAA", incidentId:"FLR-2026-0007" });
    await store.putIncidentEvidence({ id:"FLE-KEEP", incidentId:"FLR-2026-0008" });

    // An attachment pointing at an incident nobody can read is not evidence.
    const result=await store.deleteIncident("FLR-2026-0007");
    assert.equal(result.removed,true);
    assert.equal(result.attachmentsRemoved,1);
    assert.deepEqual(await store.listIncidentEvidence("FLR-2026-0007"),[]);
    assert.equal((await store.listIncidentEvidence("FLR-2026-0008")).length,1,"other incidents are untouched");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
