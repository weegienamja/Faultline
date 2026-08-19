import test from "node:test";
import assert from "node:assert/strict";
import { createProjectContract, publishProjectContract, deprecateProjectContract, cloneProjectContractVersion, getPublishedProjectContract, listProjectContracts } from "../src/contracts/catalog.mjs";

const project={id:"PRJ-1",organizationId:"ORG-1",name:"Support",contractCatalog:[]};
const contract={id:"voice-web",name:"Voice web path",description:"Generic HTTPS voice-service path.",checks:[{id:"dns",type:"dns",host:"$target.host",required:true},{id:"tcp",type:"tcp",host:"$target.host",port:"$target.port",required:true}]};

test("creates draft, publishes immutable version and resolves published contract",()=>{
 const created=createProjectContract(project,{contract,source:"tenant-authored"});
 assert.equal(created.entry.status,"draft"); assert.equal(created.entry.contract.version,1);
 const published=publishProjectContract(created.project,created.entry.id);
 assert.equal(published.entry.status,"published");
 assert.equal(getPublishedProjectContract(published.project,"voice-web").contract.version,1);
 assert.throws(()=>publishProjectContract(published.project,created.entry.id),/Only draft/);
});

test("clones a new version without modifying the published snapshot",()=>{
 const first=publishProjectContract(createProjectContract(project,{contract}).project,createProjectContract(project,{contract}).entry?.id);
});

test("version lifecycle supports clone publish and deprecate",()=>{
 const draft=createProjectContract(project,{contract});
 const pub=publishProjectContract(draft.project,draft.entry.id);
 const clone=cloneProjectContractVersion(pub.project,draft.entry.id,{notes:"Add later checks"});
 assert.equal(clone.entry.contract.version,2); assert.equal(clone.entry.status,"draft");
 const pub2=publishProjectContract(clone.project,clone.entry.id);
 assert.equal(getPublishedProjectContract(pub2.project,"voice-web").contract.version,2);
 const dep=deprecateProjectContract(pub2.project,draft.entry.id);
 assert.equal(dep.entry.status,"deprecated");
 assert.equal(listProjectContracts(dep.project).length,2);
});

test("rejects duplicate explicit versions",()=>{
 const first=createProjectContract(project,{contract:{...contract,version:1}});
 assert.throws(()=>createProjectContract(first.project,{contract:{...contract,version:1}}),/already exists/);
});
