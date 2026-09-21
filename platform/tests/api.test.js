"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
process.env.JWT_SECRET="s".repeat(40);process.env.LICENSE_KEY_PEPPER="p".repeat(40);
const {createApp}=require("../api"),auth=require("../lib/auth");
const comp={id:1,name:"Test",width:1920,height:1080,fps:24,duration:60,pixelAspect:1};
const options={format:"mp4",codec:"h264",quality:80,resolution:"source",aspectRatio:"source",targetFps:0,
 interpolate:false,upscale:1,denoise:false,sharpen:false,retentionDays:7};
const input={workflow:"CLOUD_FINISH",computeTier:"STANDARD",comp,options,inputKey:"owned-input",outputFilename:"Test.mp4"};
function memoryDB() {
 const state={license:[{id:"license1",email:"test@example.test",status:"ACTIVE",maxDevices:2,creditBalanceUnits:100000}],
  renderJob:[],upload:[{key:"owned-input",licenseId:"license1",sizeBytes:100n,contentType:"application/octet-stream",usedAt:null}],creditLedger:[],device:[]};
 function matches(row,where={}) {
  return Object.entries(where).every(([key,val])=>{
   if(key==="licenseId_clientRequestId") return matches(row,val);
   if(val && typeof val==="object" && !(val instanceof Date)){
    if("in" in val) return val.in.includes(row[key]);
    if("gte" in val) return row[key]>=val.gte;
    if("not" in val) return row[key]!==val.not;
    if("lte" in val) return row[key]<=val.lte;
   }
   return row[key]===val;
  });
 }
 function change(row,data){for(const[k,v]of Object.entries(data)){
  if(v && typeof v==="object" && "increment" in v) row[k]+=v.increment;
  else if(v && typeof v==="object" && "decrement" in v) row[k]-=v.decrement;
  else row[k]=v;
 }return {...row};}
 const db={};
 for(const name of Object.keys(state)){
  db[name]={
   findUnique:async({where})=>{const r=state[name].find(r=>matches(r,where));return r?{...r}:null;},
   findFirst:async({where})=>{const r=state[name].find(r=>matches(r,where));return r?{...r}:null;},
   findMany:async({where,take})=>state[name].filter(r=>matches(r,where)).slice(0,take).map(r=>({...r})),
   count:async({where})=>state[name].filter(r=>matches(r,where)).length,
   create:async({data})=>{const r={id:name+state[name].length,status:"RESERVED",settledAt:null,purgedAt:null,inputPurgedAt:null,expiresAt:null,createdAt:new Date(),...data};state[name].push(r);return {...r};},
   update:async({where,data})=>change(state[name].find(r=>matches(r,where)),data),
   updateMany:async({where,data})=>{const rows=state[name].filter(r=>matches(r,where));rows.forEach(r=>change(r,data));return {count:rows.length};}
  };
 }
 db.device.findFirst=async()=>({license:{...state.license[0]}});
 db.$queryRawUnsafe=async()=>[];
 let queue=Promise.resolve();
 db.$transaction=fn=>{const op=queue.then(()=>fn(db));queue=op.catch(()=>{});return op;};
 return {db,state};
}
async function setup(t){
 const {db,state}=memoryDB();let runs=0,receipt=null,status="IN_PROGRESS";
 const cloud={route:()=>({provider:"RUNPOD",providerLocation:"hidden-endpoint"}),
  capabilities:()=>({CLOUD_FINISH:["STANDARD"],FULL_PROJECT:["STANDARD"]}),
  request:async(_job,action)=>{if(action==="run"){runs++;return{id:"provider-job"};}return{status,executionTime:10};}};
 const store={head:async()=>({ContentLength:100}),readReceipt:async()=>receipt,
  signedGet:async()=> "https://storage.example.test/signed",signedPut:async()=> "https://storage.example.test/signed"};
 const server=createApp({db,store,cloud}).listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
 t.after(()=>{server.close();server.closeAllConnections();});
 async function request(route,body,extra={}) {
  const res=await fetch("http://127.0.0.1:"+server.address().port+route,{
   method:body?"POST":"GET",headers:{"Content-Type":"application/json",Authorization:"Bearer "+auth.signSession("license1","device1"),...extra},body:body?JSON.stringify(body):undefined});
  return {code:res.status,body:await res.json()};
 }
 return {state,db,cloud,store,request,runs:()=>runs,receipt:r=>{receipt=r;},status:s=>{status=s;}};
}
test("API hides providers and rejects an invalid format before reserving credits",async t=>{
 const c=await setup(t);const caps=await c.request("/api/v1/capabilities");
 assert.equal(JSON.stringify(caps.body).includes("RUNPOD"),false);
 const bad=await c.request("/api/v1/estimate",{...input,options:{...options,format:"webm"}});
 assert.equal(bad.code,400);assert.equal(c.state.license[0].creditBalanceUnits,100000);
 const png=await c.request("/api/v1/estimate",{...input,workflow:"FULL_PROJECT",options:{...options,format:"png_sequence",codec:"png"}});
 assert.equal(png.code,200);
});
test("retries reserve once; completion settles once and starts retention",async t=>{
 const c=await setup(t),headers={"Idempotency-Key":"repeat-request-12345"};
 const responses=await Promise.all([c.request("/api/v1/jobs",input,headers),c.request("/api/v1/jobs",input,headers)]);
 assert.equal(responses[0].code,202);assert.equal(c.runs(),1);assert.equal(c.state.renderJob.length,1);
 const job=c.state.renderJob[0];assert.equal(job.expiresAt,null);
 const reserved=c.state.license[0].creditBalanceUnits;
 c.receipt({jobId:job.id,status:"COMPLETED",executionTimeMs:1});
 const before=Date.now(),done=await c.request("/api/v1/jobs/"+job.id);
 assert.equal(done.body.status,"COMPLETED");assert.ok(c.state.license[0].creditBalanceUnits>reserved);
 const balance=c.state.license[0].creditBalanceUnits;
 await c.request("/api/v1/jobs/"+job.id);
 assert.equal(c.state.license[0].creditBalanceUnits,balance);
 assert.equal(c.state.creditLedger.filter(l=>l.externalRef==="settle:"+job.id).length,1);
 assert.ok(+new Date(done.body.expiresAt)>=before+7*86400000);
 assert.equal("providerLocation" in done.body,false);
});
test("cancellation waits for terminal provider confirmation before refunding",async t=>{
 const c=await setup(t);
 const {body:job}=await c.request("/api/v1/jobs",input,{"Idempotency-Key":"cancel-request-12345"});
 const balance=c.state.license[0].creditBalanceUnits;
 await c.request("/api/v1/jobs/"+job.jobId+"/cancel",{});
 assert.equal(c.state.license[0].creditBalanceUnits,balance);
 c.status("CANCELLED");await c.request("/api/v1/jobs/"+job.jobId);
 assert.equal(c.state.license[0].creditBalanceUnits,100000);
});
test("dispatch response loss preserves reservation for reconciliation",async t=>{
 const c=await setup(t);
 c.cloud.request=async()=>{throw Object.assign(new Error("lost"),{uncertain:true});};
 const {body:job}=await c.request("/api/v1/jobs",input,{"Idempotency-Key":"uncertain-request-12345"});
 assert.equal(job.status,"RESERVED");assert.ok(c.state.license[0].creditBalanceUnits<100000);
 c.receipt({jobId:job.jobId,status:"COMPLETED",executionTimeMs:1});
 assert.equal((await c.request("/api/v1/jobs/"+job.jobId)).body.status,"COMPLETED");
});
test("failure to record an accepted dispatch cannot refund running work",async t=>{
 const c=await setup(t),update=c.db.renderJob.updateMany;
 c.db.renderJob.updateMany=async args=>{
  if(args.data.providerJobId) throw new Error("database disconnected");
  return update(args);
 };
 const {body:job}=await c.request("/api/v1/jobs",input,{"Idempotency-Key":"db-failure-request-12345"});
 assert.equal(job.status,"RESERVED");assert.equal(c.runs(),1);assert.ok(c.state.license[0].creditBalanceUnits<100000);
});
test("upload ownership and missing admin secrets fail closed",async t=>{
 const c=await setup(t);c.state.upload[0].licenseId="someone-else";
 assert.equal((await c.request("/api/v1/jobs",input,{"Idempotency-Key":"ownership-request-12345"})).code,400);
 delete process.env.ADMIN_SECRET;
 assert.equal((await c.request("/api/v1/admin/devices/reset",{licenseKey:"example"},{Authorization:"Bearer "})).code,401);
});
test("retention cleanup retries failed deletes before marking output purged",async t=>{
 const c=await setup(t);process.env.CRON_SECRET="c".repeat(40);
 const {body:job}=await c.request("/api/v1/jobs",input,{"Idempotency-Key":"cleanup-request-12345"});
 c.receipt({jobId:job.jobId,status:"COMPLETED",executionTimeMs:1});
 await c.request("/api/v1/jobs/"+job.jobId);
 const row=c.state.renderJob[0],removed=[];row.expiresAt=new Date(Date.now()-1000);
 let failOnce=true;
 c.store.remove=async key=>{if(key===row.outputKey && failOnce){failOnce=false;throw new Error("temporary");}removed.push(key);};
 const headers={Authorization:"Bearer "+process.env.CRON_SECRET};
 const first=await c.request("/api/cron/reconcile",undefined,headers);
 assert.equal(first.body.purged,0);assert.equal(row.purgedAt,null);assert.ok(row.inputPurgedAt);
 const second=await c.request("/api/cron/reconcile",undefined,headers);
 assert.equal(second.body.purged,1);assert.ok(row.purgedAt);
 assert.ok(removed.includes(row.outputKey));assert.ok(removed.includes(row.receiptKey));
 assert.equal((await c.request("/api/v1/jobs/"+job.jobId)).body.downloadUrl,null);
});
