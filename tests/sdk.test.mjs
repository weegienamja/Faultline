import test from "node:test";
import assert from "node:assert/strict";
import { FaultlineClient } from "../sdk/faultline.mjs";

test("SDK sends scoped bearer key and JSON payloads",async()=>{
 const calls=[];
 const client=new FaultlineClient({baseUrl:"https://faultline.example",apiKey:"fl_api_test",fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({caseId:"CASE-1",sessionId:"FL-1"})};}});
 const result=await client.createDiagnostic({target:"example.com"});
 assert.equal(result.sessionId,"FL-1"); assert.equal(calls[0].url,"https://faultline.example/api/v1/diagnostics"); assert.equal(calls[0].options.headers.authorization,"Bearer fl_api_test"); assert.match(calls[0].options.body,/example.com/);
});

test("SDK exposes case/evidence/embed helpers",async()=>{
 const paths=[]; const client=new FaultlineClient({baseUrl:"https://f",apiKey:"k",fetchImpl:async(url)=>{paths.push(url);return {ok:true,json:async()=>({})};}});
 await client.getDiagnostic("FL 1"); await client.getCase("CASE 1"); await client.getEvidence("CASE 1"); await client.createEmbedToken({target:"example.com"});
 assert.deepEqual(paths.slice(0,3),["https://f/api/v1/diagnostics/FL%201","https://f/api/v1/cases/CASE%201","https://f/api/v1/cases/CASE%201/evidence"]);
});
