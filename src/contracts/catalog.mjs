import { randomBytes } from "node:crypto";
import { validateConnectivityContract } from "./registry.mjs";

const STATUSES=new Set(["draft","published","deprecated"]);
function nowIso(now){return new Date(now).toISOString();}
function entryId(){return `CTR-${randomBytes(6).toString("hex").toUpperCase()}`;}
function clean(value,fallback,max,field){const text=String(value??fallback).trim();if(!text)throw new Error(`${field} is required.`);if(text.length>max)throw new Error(`${field} must be ${max} characters or fewer.`);return text;}
function catalog(project){return Array.isArray(project.contractCatalog)?project.contractCatalog:[];}

export function listProjectContracts(project,{status=null}={}){return catalog(project).filter(item=>!status||item.status===status).map(item=>structuredClone(item)).sort((a,b)=>String(a.contract.id).localeCompare(String(b.contract.id))||b.contract.version-a.contract.version);}

export function createProjectContract(project,input={},now=Date.now()){
 const contract=validateConnectivityContract(input.contract||input);
 const existing=catalog(project).filter(item=>item.contract.id===contract.id);
 const version=input.version?Number(input.version):Math.max(0,...existing.map(item=>item.contract.version))+1;
 contract.version=version||1;
 if(existing.some(item=>item.contract.version===contract.version)) throw new Error(`Connectivity contract ${contract.id} v${contract.version} already exists in this project.`);
 const entry={id:entryId(),status:"draft",contract,provenance:{source:clean(input.source,"tenant-authored",120,"Contract source"),referenceUrl:input.referenceUrl?clean(input.referenceUrl,"",500,"Reference URL"):null,verifiedBy:input.verifiedBy?clean(input.verifiedBy,"",120,"Verifier"):null,notes:input.notes?clean(input.notes,"",600,"Contract notes"):null},createdAt:nowIso(now),updatedAt:nowIso(now),publishedAt:null,deprecatedAt:null};
 return {project:{...project,contractCatalog:[...catalog(project),entry],updatedAt:nowIso(now)},entry:structuredClone(entry)};
}

function mutateEntry(project,entryIdValue,mutator){const items=catalog(project);const index=items.findIndex(item=>item.id===entryIdValue);if(index<0){const e=new Error("Contract catalog entry was not found.");e.statusCode=404;throw e;}const next=structuredClone(items);next[index]=mutator(structuredClone(next[index]));return {...project,contractCatalog:next};}

export function publishProjectContract(project,entryIdValue,now=Date.now()){
 let published;
 const updated=mutateEntry(project,entryIdValue,entry=>{if(entry.status!=="draft")throw new Error("Only draft contracts can be published.");published={...entry,status:"published",publishedAt:nowIso(now),updatedAt:nowIso(now)};return published;});
 return {project:{...updated,updatedAt:nowIso(now)},entry:published};
}
export function deprecateProjectContract(project,entryIdValue,now=Date.now()){
 let deprecated;
 const updated=mutateEntry(project,entryIdValue,entry=>{if(entry.status!=="published")throw new Error("Only published contracts can be deprecated.");deprecated={...entry,status:"deprecated",deprecatedAt:nowIso(now),updatedAt:nowIso(now)};return deprecated;});
 return {project:{...updated,updatedAt:nowIso(now)},entry:deprecated};
}
export function cloneProjectContractVersion(project,entryIdValue,input={},now=Date.now()){
 const source=catalog(project).find(item=>item.id===entryIdValue);if(!source){const e=new Error("Contract catalog entry was not found.");e.statusCode=404;throw e;}
 return createProjectContract(project,{...input,contract:{...structuredClone(source.contract),...(input.contract||{}),version:undefined},source:input.source||`cloned-from:${source.id}`,referenceUrl:input.referenceUrl??source.provenance?.referenceUrl,notes:input.notes||`New draft from ${source.contract.id} v${source.contract.version}.`},now);
}
export function getPublishedProjectContract(project,contractId,version=null){const matches=catalog(project).filter(item=>item.contract.id===contractId&&item.status==="published"&&(!version||item.contract.version===Number(version))).sort((a,b)=>b.contract.version-a.contract.version);if(!matches.length){const e=new Error(`Published connectivity contract ${contractId}${version?` v${version}`:""} was not found.`);e.statusCode=404;throw e;}return structuredClone(matches[0]);}
export function assertCatalogStatus(status){if(!STATUSES.has(status))throw new Error("Unsupported contract catalog status.");return status;}
