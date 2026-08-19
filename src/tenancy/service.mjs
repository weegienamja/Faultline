import { randomBytes } from "node:crypto";
import { generateCredential, hashCredential, verifyCredential } from "../security/auth.mjs";

function clean(value, fallback, max, field) { const text=String(value??fallback).trim(); if(!text) throw new Error(`${field} is required.`); if(text.length>max) throw new Error(`${field} must be ${max} characters or fewer.`); return text; }
function id(prefix){ return `${prefix}-${randomBytes(7).toString("hex").toUpperCase()}`; }

export function createOrganization(input={}, now=Date.now()) {
  const credential=generateCredential("fl_org");
  const createdAt=new Date(now).toISOString();
  const organization={ id:id("ORG"), name:clean(input.name,"",160,"Organization name"), slug:clean(input.slug||input.name,"",80,"Organization slug").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""), enabled:true, credentialHash:hashCredential(credential), credentialVersion:1, createdAt, updatedAt:createdAt, revokedAt:null };
  if(!organization.slug) throw new Error("Organization slug is invalid.");
  return { organization, credential };
}

export function publicOrganization(org){ return { id:org.id,name:org.name,slug:org.slug,enabled:org.enabled!==false,credentialVersion:org.credentialVersion||1,createdAt:org.createdAt,updatedAt:org.updatedAt,revokedAt:org.revokedAt||null }; }

export function findOrganizationAccess(organizations=[], token){ if(!token) return null; return organizations.find(org=>org.enabled!==false&&!org.revokedAt&&verifyCredential(token,org.credentialHash))||null; }

export function rotateOrganizationCredential(org, now=Date.now()){ const credential=generateCredential("fl_org"); const organization={...org,credentialHash:hashCredential(credential),credentialVersion:Number(org.credentialVersion||1)+1,updatedAt:new Date(now).toISOString()}; return {organization,credential}; }
export function revokeOrganizationCredential(org, now=Date.now()){ return {...org,credentialHash:null,enabled:false,revokedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()}; }

export function createProject(organization, input={}, now=Date.now()){ if(!organization?.id) throw new Error("Organization is required."); const createdAt=new Date(now).toISOString(); return { id:id("PRJ"), organizationId:organization.id, name:clean(input.name,"Default project",160,"Project name"), slug:clean(input.slug||input.name||"default","default",80,"Project slug").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""), enabled:true, createdAt,updatedAt:createdAt }; }
export function publicProject(project){ return {id:project.id,organizationId:project.organizationId,name:project.name,slug:project.slug,enabled:project.enabled!==false,createdAt:project.createdAt,updatedAt:project.updatedAt}; }

export function scopeCaseToTenant(caseRecord, organizationId, projectId){ if(!caseRecord?.id) throw new Error("Support case is required."); return {...caseRecord,organizationId,projectId}; }
export function assertTenantCase(caseRecord, org, project=null){ if(!caseRecord||caseRecord.organizationId!==org.id||(project&&caseRecord.projectId!==project.id)){ const error=new Error("Support case was not found in this tenant scope."); error.statusCode=404; throw error;} return caseRecord; }
