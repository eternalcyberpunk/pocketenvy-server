"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {spawn,spawnSync} = require("child_process");
const express = require("express");

function createAgent(config = {}) {
  const root = path.resolve(config.root || process.env.WORK_ROOT || "C:\\PocketEnvyJobs");
  const key = config.key || process.env.AE_FARM_API_KEY || "";
  if (key.length < 32 || /generate_|replace_me/i.test(key)) throw new Error("Set AE_FARM_API_KEY to at least 32 random characters.");
  fs.mkdirSync(root,{recursive:true});
  const jobs = new Map(); let active = null, closing = false;
  const view = job => ({id:job.id,status:job.status,executionTimeMs:job.executionTimeMs || 0});
  const persist = job => {
    const filename = path.join(root,job.id,"state.json");
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    fs.writeFileSync(filename + ".tmp",JSON.stringify(view(job)));
    fs.renameSync(filename + ".tmp",filename);
  };
  for (const entry of fs.readdirSync(root)) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(entry)) continue;
    const state = path.join(root,entry,"state.json");
    if (!fs.existsSync(state)) continue;
    const job = JSON.parse(fs.readFileSync(state,"utf8"));
    const result = path.join(root,entry,"result.json");
    if (fs.existsSync(result)) {
      const data = JSON.parse(fs.readFileSync(result,"utf8"));
      job.status = data.status; job.executionTimeMs = data.executionTimeMs;
    } else if (job.status === "IN_PROGRESS") job.status = "FAILED";
    jobs.set(job.id,job); persist(job);
  }
  function kill(child) {
    if (process.platform === "win32") spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true});
    else if (child.pid) { try { process.kill(-child.pid,"SIGKILL"); } catch (_) { child.kill("SIGKILL"); } }
  }
  function drain() {
    if (active || config.pause || closing) return;
    const job = Array.from(jobs.values()).find(j=>j.status === "IN_QUEUE");
    if (!job) return;
    const dir = path.join(root,job.id);
    job.status = "IN_PROGRESS"; job.startedAt = Date.now(); persist(job);
    const command = config.command || process.env.PYTHON_PATH || "python";
    const args = config.args ? config.args(job) : [path.join(__dirname,"..","worker","project_task.py"),path.join(dir,"payload.json")];
    const child = spawn(command,args,{windowsHide:true,detached:process.platform!=="win32",stdio:"ignore"});
    active = {job,child};
    const timer = setTimeout(()=>{job.status="TIMED_OUT";kill(child);},Number(process.env.JOB_TIMEOUT_MS||21600000));
    let ended = false;
    function done(code) {
      if (ended) return; ended=true; clearTimeout(timer);
      if (!["CANCELLED","TIMED_OUT"].includes(job.status)) {
        const file = path.join(dir,"result.json");
        let result;
        try { result=JSON.parse(fs.readFileSync(file,"utf8")); } catch (_) {}
        job.status = code===0 && result?.status==="COMPLETED" ? "COMPLETED" : "FAILED";
        job.executionTimeMs = result?.executionTimeMs || Date.now()-job.startedAt;
      }
      persist(job); active=null;
      // Task process is stopped; remove only this node's own job scratch.
      fs.rmSync(path.join(dir,"work"),{recursive:true,force:true});
      fs.rmSync(path.join(dir,"payload.json"),{force:true});
      drain();
    }
    child.on("error",()=>done(1)); child.on("close",done);
  }
  const app = express(); app.disable("x-powered-by"); app.use(express.json({limit:"128kb"}));
  app.use((req,res,next)=>{
    const supplied = Buffer.from(String(req.headers.authorization||"").replace(/^Bearer\s+/i,""));
    const secret = Buffer.from(key);
    if (supplied.length !== secret.length || !crypto.timingSafeEqual(supplied,secret)) return res.status(401).json({error:"Unauthorized."});
    res.set("Cache-Control","no-store"); next();
  });
  app.get("/v1/health",(_req,res)=>res.json({ok:true,active:!!active}));
  app.post("/v1/jobs",(req,res)=>{
    const payload=req.body, id=payload?.job_id;
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id || "") || !payload.comp || !payload.options) return res.status(400).json({error:"Invalid job."});
    if (jobs.has(id)) return res.json(view(jobs.get(id)));
    const allowed = String(process.env.STORAGE_HOSTS||"").split(",").map(x=>x.trim().toLowerCase());
    for (const field of ["input_url","output_url","receipt_url"]) {
      let url;
      try { url=new URL(payload[field]); } catch (_) { return res.status(400).json({error:"Invalid transfer URL."}); }
      if (url.protocol!=="https:" || url.username || url.password || !allowed.includes(url.hostname.toLowerCase())) return res.status(400).json({error:"Transfer host is not allowed."});
    }
    if (Array.from(jobs.values()).filter(j=>["IN_QUEUE","IN_PROGRESS"].includes(j.status)).length>=Number(process.env.MAX_QUEUE||10)) return res.status(429).json({error:"Render node queue is full."});
    const job={id,status:"IN_QUEUE"}; jobs.set(id,job); persist(job);
    fs.writeFileSync(path.join(root,id,"payload.json"),JSON.stringify(payload));
    res.status(202).json(view(job)); drain();
  });
  app.get("/v1/jobs/:id",(req,res)=>{const job=jobs.get(req.params.id); return job ? res.json(view(job)) : res.status(404).json({error:"Job not found."});});
  app.post("/v1/jobs/:id/cancel",(req,res)=>{
    const job=jobs.get(req.params.id);
    if (!job) return res.status(404).json({error:"Job not found."});
    if (job.status==="IN_QUEUE") {job.status="CANCELLED";persist(job);fs.rmSync(path.join(root,job.id,"payload.json"),{force:true});}
    else if (job.status==="IN_PROGRESS" && active?.job.id===job.id) {
      job.status="CANCELLED";kill(active.child);persist(job);
    }
    return res.json(view(job));
  });
  // Durable states are restored before the queue starts.
  drain();
  return {app, close:()=>{closing=true;if(active)kill(active.child);}, jobs};
}
if (require.main===module) {
  const agent=createAgent();
  const server = agent.app.listen(Number(process.env.PORT||8787),process.env.BIND_HOST||"127.0.0.1",()=>console.log("PocketEnvy render node ready."));
  for (const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>{agent.close();server.close();});
}
module.exports={createAgent};
