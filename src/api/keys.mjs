import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, verifyCredential } from "../security/auth.mjs";

const API_SCOPES=new Set(["diagnostics:create","diagnostics:read","cases:read","evidence:read"]);
function id(prefix){return `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;}
function nowIso(now){return new Date(now).toISOString();}
function keys(project){return Array.isArray(project.apiKeys)?project.apiKeys:[];}
function embeds(project){return Array.isArray(project.embedTokens)?project.embedTokens:[];}

export function createProjectApiKey(project,input={},now=Date.now()){
 const requested=Array.isArray(input.scopes)&&input.scopes.length?input.scopes:[...API_SCOPES];
 const scopes=[...new Set(requested.map(String))]; if(scopes.some(scope=>!API_SCOPES.has(scope))) throw new Error("Unsupported API key scope.");
 const credential=generateCredential("fl_api"); const record={id:id("KEY"),name:String(input.name||"Embedded diagnostics key").trim().slice(0,120),scopes,credentialHash:hashCredential(credential),createdAt:nowIso(now),lastUsedAt:null,revokedAt:null};
 return {project:{...project,apiKeys:[...keys(project),record],updatedAt:nowIso(now)},apiKey:{id:record.id,name:record.name,scopes,createdAt:record.createdAt,revokedAt:null},credential};
}
export function findProjectApiAccess(projects=[],token,scope=null){if(!token)return null;for(const project of projects){const key=keys(project).find(item=>!item.revokedAt&&verifyCredential(token,item.credentialHash));if(!key)continue;if(scope&&!key.scopes.includes(scope))return null;return {project,key};}return null;}
export function revokeProjectApiKey(project,keyId,now=Date.now()){let found=false;const updatedKeys=keys(project).map(item=>{if(item.id!==keyId)return item;found=true;return {...item,credentialHash:null,revokedAt:nowIso(now)};});if(!found){const e=new Error("Project API key was not found.");e.statusCode=404;throw e;}return {...project,apiKeys:updatedKeys,updatedAt:nowIso(now)};}
export function publicApiKeys(project){return keys(project).map(({credentialHash,...item})=>structuredClone(item));}

export function createEmbedToken(project,input={},now=Date.now()){
 const ttlMinutes=Math.max(1,Math.min(30,Number(input.ttlMinutes||10))); const credential=generateCredential("fl_embed"); const token={id:id("EMB"),credentialHash:hashCredential(credential),target:String(input.target||"").trim(),catalogContractId:input.catalogContractId?String(input.catalogContractId):null,caseId:input.caseId?String(input.caseId):null,createdAt:nowIso(now),expiresAt:nowIso(now+ttlMinutes*60000),consumedAt:null}; if(!token.target)throw new Error("Embed token requires a diagnostic target.");
 return {project:{...project,embedTokens:[...embeds(project).filter(item=>Date.parse(item.expiresAt)>now&&!item.consumedAt),token].slice(-100),updatedAt:nowIso(now)},credential,token:{id:token.id,target:token.target,expiresAt:token.expiresAt}};
}
export function findEmbedAccess(projects=[],credential,now=Date.now()){if(!credential)return null;for(const project of projects){const token=embeds(project).find(item=>!item.consumedAt&&Date.parse(item.expiresAt)>now&&verifyCredential(credential,item.credentialHash));if(token)return {project,token};}return null;}
export function consumeEmbedToken(project,tokenId,now=Date.now()){let consumed;const updated=embeds(project).map(item=>{if(item.id!==tokenId)return item;consumed={...item,credentialHash:null,consumedAt:nowIso(now)};return consumed;});if(!consumed)throw new Error("Embed token was not found.");return {project:{...project,embedTokens:updated,updatedAt:nowIso(now)},token:consumed};}
