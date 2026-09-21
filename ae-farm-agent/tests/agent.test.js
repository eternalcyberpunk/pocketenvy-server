"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("fs"),os=require("os"),path=require("path");
const {createAgent}=require("../server");
process.env.STORAGE_HOSTS="storage.example.test";
const key="k".repeat(40);
const payload=id=>({job_id:id,comp:{},options:{},input_url:"https://storage.example.test/input",
 output_url:"https://storage.example.test/output",receipt_url:"https://storage.example.test/receipt"});
async function launch(t,config) {
 const agent=createAgent({...config,key}),server=agent.app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));t.after(()=>{agent.close();server.close();server.closeAllConnections();});
 return {agent,request:async(route,body)=>{
   const r=await fetch("http://127.0.0.1:"+server.address().port+route,{method:body?"POST":"GET",
    headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
   return {code:r.status,data:await r.json()};
 }};
}
test("queued cancellation survives restart and idempotent retries",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"pe-agent-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const first=await launch(t,{root,pause:true});
 assert.equal((await first.request("/v1/jobs",payload("job-12345678"))).code,202);
 assert.equal((await first.request("/v1/jobs",payload("job-12345678"))).code,200);
 assert.equal((await first.request("/v1/jobs/job-12345678/cancel",{})).data.status,"CANCELLED");
 const second=await launch(t,{root,pause:true});
 assert.equal((await second.request("/v1/jobs/job-12345678")).data.status,"CANCELLED");
 assert.equal(fs.existsSync(path.join(root,"job-12345678","payload.json")),false);
});
test("active cancellation kills the task process and drains the next job",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"pe-agent-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const node=await launch(t,{root,command:process.execPath,args:()=>["-e","setInterval(()=>{},1000)"]});
 await node.request("/v1/jobs",payload("job-active123"));
 await node.request("/v1/jobs",payload("job-queued123"));
 assert.equal((await node.request("/v1/jobs/job-active123")).data.status,"IN_PROGRESS");
 await node.request("/v1/jobs/job-active123/cancel",{});
 for(let i=0;i<30;i++){
   const next=(await node.request("/v1/jobs/job-queued123")).data;
   if(next.status==="IN_PROGRESS") break;
   await new Promise(r=>setTimeout(r,20));
 }
 assert.equal((await node.request("/v1/jobs/job-queued123")).data.status,"IN_PROGRESS");
 await node.request("/v1/jobs/job-queued123/cancel",{});
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await node.request("/v1/jobs/job-active123")).data.status,"CANCELLED");
});
test("transfer destinations are restricted to configured storage",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"pe-agent-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const node=await launch(t,{root,pause:true});
 assert.equal((await node.request("/v1/jobs",{...payload("job-12345678"),output_url:"https://evil.test/upload"})).code,400);
});
