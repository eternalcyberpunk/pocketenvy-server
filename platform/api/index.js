"use strict";
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { z } = require("zod");
const { prisma } = require("../lib/db");
const auth = require("../lib/auth");
const { quote, actualCreditUnits } = require("../lib/credits");
const { jobSchema, estimateSchema, formats } = require("../lib/options");
const storage = require("../lib/storage");
const providers = require("../lib/providers");
const ACTIVE = ["RESERVED","IN_QUEUE","IN_PROGRESS"];
const TERMINAL = ["COMPLETED","FAILED","CANCELLED","TIMED_OUT"];
const MAX_UPLOAD = Math.min(Number(process.env.MAX_UPLOAD_BYTES || 4294967296), 4294967296);
const fail = (message, statusCode) => Object.assign(new Error(message), {statusCode});
const accountView = a => ({email:a.email, creditBalanceUnits:a.creditBalanceUnits, status:a.status, maxDevices:a.maxDevices});
const safeFilename = name => String(name).split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,160);
const route = handler => (req,res,next) => Promise.resolve(handler(req,res,next)).catch(next);

function createApp({db = prisma, store = storage, cloud = providers} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({crossOriginResourcePolicy:false}));
  app.use(cors({origin:(origin, cb) => {
    const allowed = String(process.env.ALLOWED_ORIGINS || "null").split(",").map(s=>s.trim());
    cb(null, !origin || allowed.includes(origin));
  }}));
  app.use(express.json({limit:"128kb"}));
  app.use((_req,res,next) => { res.set("Cache-Control","no-store"); next(); });
  function secret(name) { return (req,res,next) => auth.safeEqual(String(req.headers.authorization || "").replace(/^Bearer\s+/i,""), process.env[name]) ? next() : res.status(401).json({error:"Unauthorized."}); }
  const requireAuth = route(async (req,res,next) => {
    let token;
    try { token = auth.verifySession(String(req.headers.authorization || "").replace(/^Bearer\s+/i,"")); }
    catch (_) { return res.status(401).json({error:"Activate PocketEnvy again to continue."}); }
    const device = await db.device.findFirst({where:{licenseId:token.sub,deviceHash:token.device,active:true},include:{license:true}});
    if (!device || device.license.status !== "ACTIVE") throw fail("License session is inactive.",401);
    req.account = device.license; next();
  });
  // The SQL is constant. IDs are bound parameters, never interpolated SQL.
  async function lockAccount(tx,id) { await tx.$queryRawUnsafe('SELECT "id" FROM "License" WHERE "id" = $1 FOR UPDATE',id); }
  async function lockJob(tx,id) { await tx.$queryRawUnsafe('SELECT "id" FROM "RenderJob" WHERE "id" = $1 FOR UPDATE',id); }
  async function settle(job,status) {
    if (!TERMINAL.includes(status.status)) {
      await db.renderJob.updateMany({where:{id:job.id,settledAt:null},
        data:{status:status.status === "IN_PROGRESS" ? "IN_PROGRESS" : "IN_QUEUE"}});
      return db.renderJob.findUnique({where:{id:job.id}});
    }
    return db.$transaction(async tx => {
      await lockJob(tx,job.id);
      const fresh = await tx.renderJob.findUnique({where:{id:job.id}});
      if (fresh.settledAt) return fresh;
      const completed = status.status === "COMPLETED";
      const execution = Math.min(86400000, Math.max(0, Number(status.executionTimeMs || status.executionTime || 0)));
      const charged = completed ? actualCreditUnits(execution, fresh.reservedCreditUnits, fresh.pricing) : 0;
      const refund = fresh.reservedCreditUnits - charged;
      if (refund > 0) {
        await tx.license.update({where:{id:fresh.licenseId},data:{creditBalanceUnits:{increment:refund}}});
        await tx.creditLedger.create({data:{licenseId:fresh.licenseId,jobId:fresh.id,units:refund,
          kind:completed ? "JOB_SETTLEMENT" : "JOB_REFUND",externalRef:"settle:" + fresh.id,
          note:completed ? "Unused reservation returned" : "Unsuccessful render refunded"}});
      }
      return tx.renderJob.update({where:{id:fresh.id},data:{
        status:status.status,settledCreditUnits:charged,executionTimeMs:execution,settledAt:new Date(),
        expiresAt:new Date(Date.now() + (completed ? fresh.options.retentionDays : 1) * 86400000),
        error:completed ? null : "Render " + status.status.toLowerCase().replace("_"," ") + ". Reserved credits returned."
      }});
    });
  }
  async function refresh(job) {
    if (job.settledAt) return job;
    const receipt = await store.readReceipt(job.receiptKey);
    if (receipt && receipt.jobId === job.id && TERMINAL.includes(receipt.status)) {
      if (receipt.status === "COMPLETED" && !(await store.head(job.outputKey))) throw fail("Finished file is not yet available. Try again shortly.",503);
      return settle(job,receipt);
    }
    if (job.providerJobId) {
      try {
        const status = await cloud.request(job,"status");
        if (status.status === "COMPLETED") {
          if (!(await store.head(job.outputKey))) return settle(job,{status:"FAILED"});
          if (status.output?.status === "FAILED") return settle(job,{status:"FAILED"});
        }
        job = await settle(job,status);
      } catch (error) {
        if (error.httpStatus !== 404 && Date.now() < +job.deadlineAt) throw fail("Cloud status is temporarily unavailable. Your job is still tracked.",503);
      }
    }
    if (!job.settledAt && Date.now() >= +job.deadlineAt) return settle(job,{status:"TIMED_OUT"});
    if (!job.settledAt) await db.renderJob.updateMany({where:{id:job.id,settledAt:null},data:{updatedAt:new Date()}});
    return job;
  }
  async function view(job) {
    const expired = job.expiresAt && +job.expiresAt <= Date.now();
    const result = {jobId:job.id,status:job.status,workflow:job.workflow,computeTier:job.computeTier,
      outputFilename:job.outputFilename,format:job.options.format,createdAt:job.createdAt,expiresAt:job.expiresAt,
      reservedCreditUnits:job.reservedCreditUnits,settledCreditUnits:job.settledCreditUnits,
      error:job.error,downloadUrl:null};
    if (job.status === "COMPLETED" && !expired && !job.purgedAt) {
      const ttl = Math.max(1, Math.min(3600, Math.floor((+job.expiresAt - Date.now())/1000)));
      result.downloadUrl = await store.signedGet(job.outputKey,ttl);
    }
    if (expired || job.purgedAt) result.error = "The selected storage period has ended.";
    return result;
  }
  function ensureAvailable(input) {
    const selected = cloud.route(input.workflow,input.computeTier);
    if (!selected || !cloud.capabilities()[input.workflow].includes(input.computeTier))
      throw fail("This workflow and speed tier is not available yet. Choose an available tier.",503);
    return selected;
  }
  app.get("/api/health", (_req,res) => res.json({ok:true,service:"pocketenvy-api",version:"2.0.0"}));
  app.get("/api/v1/capabilities", (_req,res) => res.json({workflows:cloud.capabilities(), maxUploadBytes:MAX_UPLOAD,
    maxDimension:8192,retentionDays:[1,3,7,30]}));
  const activation = z.object({email:z.string().email().max(320),licenseKey:z.string().min(6).max(256),
    deviceId:z.string().min(16).max(128),deviceName:z.string().max(120).optional()});
  app.post("/api/v1/license/activate", route(async(req,res) => {
    if (!auth.ready())
      throw fail("PocketEnvy activation is awaiting service setup.",503);
    const input = activation.parse(req.body); const hash = auth.deviceHash(input.deviceId);
    const license = await db.$transaction(async tx => {
      let account = await tx.license.findUnique({where:{keyHash:auth.licenseKeyHash(input.licenseKey)}});
      if (!account || account.email !== auth.normalizeEmail(input.email) || account.status !== "ACTIVE") throw fail("Email or license key is invalid.",401);
      await lockAccount(tx,account.id);
      const existing = await tx.device.findUnique({where:{licenseId_deviceHash:{licenseId:account.id,deviceHash:hash}}});
      const count = await tx.device.count({where:{licenseId:account.id,active:true}});
      if (!existing?.active && count >= account.maxDevices) throw fail("Device limit reached. Contact support to reset an activation.",409);
      await tx.device.upsert({where:{licenseId_deviceHash:{licenseId:account.id,deviceHash:hash}},
        create:{licenseId:account.id,deviceHash:hash,name:input.deviceName},update:{active:true,name:input.deviceName,lastSeenAt:new Date()}});
      return account;
    });
    res.json({token:auth.signSession(license.id,hash),account:accountView(license)});
  }));
  app.get("/api/v1/me",requireAuth,(req,res) => res.json(accountView(req.account)));
  app.post("/api/v1/estimate",requireAuth,route(async(req,res) => {
    const input = estimateSchema.parse(req.body); ensureAvailable(input);
    const result = quote(input.comp,{...input.options,workflow:input.workflow,computeTier:input.computeTier});
    res.json({estimatedCreditUnits:result.reservedCreditUnits,estimatedCredits:result.reservedCreditUnits/1000,
      output:result.output,retentionCreditUnits:result.pricing.retentionUnits,
      sufficientBalance:req.account.creditBalanceUnits >= result.reservedCreditUnits});
  }));
  const uploadSchema = z.object({filename:z.string().min(1).max(180),contentType:z.enum(["video/quicktime","application/octet-stream","application/zip"]),
    fileSizeBytes:z.number().int().positive().max(MAX_UPLOAD)});
  app.post("/api/v1/uploads",requireAuth,route(async(req,res) => {
    const input = uploadSchema.parse(req.body);
    if (req.account.creditBalanceUnits <= 0) throw fail("Add credits before uploading.",402);
    const key = "inputs/" + req.account.id + "/" + crypto.randomUUID() + "-" + safeFilename(input.filename);
    await db.$transaction(async tx => {
      await lockAccount(tx,req.account.id);
      const count = await tx.upload.count({where:{licenseId:req.account.id,usedAt:null,createdAt:{gte:new Date(Date.now()-86400000)}}});
      if (count >= 10) throw fail("Too many pending uploads. Try again later.",429);
      await tx.upload.create({data:{key,licenseId:req.account.id,contentType:input.contentType,sizeBytes:BigInt(input.fileSizeBytes)}});
    });
    res.status(201).json({inputKey:key,uploadUrl:await store.signedPut(key,input.contentType,3600,input.fileSizeBytes),expiresIn:3600});
  }));
  app.post("/api/v1/jobs",requireAuth,route(async(req,res) => {
    const input = jobSchema.parse(req.body);
    const requestId = String(req.headers["idempotency-key"] || "");
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw fail("A valid Idempotency-Key is required.",400);
    const where = {licenseId_clientRequestId:{licenseId:req.account.id,clientRequestId:requestId}};
    const duplicate = await db.renderJob.findUnique({where});
    if (duplicate) return res.json({...await view(duplicate),account:accountView(req.account)});
    const selected = ensureAvailable(input);
    const upload = await db.upload.findUnique({where:{key:input.inputKey}});
    if (!upload || upload.licenseId !== req.account.id || upload.usedAt) throw fail("Select a fresh upload owned by your account.",400);
    if (input.workflow === "FULL_PROJECT" && upload.contentType !== "application/zip") throw fail("Full Project requires a project ZIP.",400);
    const object = await store.head(input.inputKey);
    if (!object || BigInt(object.ContentLength) !== upload.sizeBytes || object.ContentLength > MAX_UPLOAD) throw fail("Upload is incomplete or exceeds the file limit.",400);
    const result = quote(input.comp,{...input.options,workflow:input.workflow,computeTier:input.computeTier});
    const filename = safeFilename(input.outputFilename).replace(/\.[^.]*$/,"") + "." + formats[input.options.format].extension;
    const outputKey = "outputs/" + req.account.id + "/" + crypto.randomUUID() + "/" + filename;
    const job = await db.$transaction(async tx => {
      await lockAccount(tx,req.account.id);
      const previous = await tx.renderJob.findUnique({where});
      if (previous) return {previous};
      const active = await tx.renderJob.count({where:{licenseId:req.account.id,status:{in:ACTIVE}}});
      if (active >= Number(process.env.MAX_ACTIVE_JOBS || 2)) throw fail("Active render limit reached.",429);
      const changed = await tx.license.updateMany({where:{id:req.account.id,status:"ACTIVE",creditBalanceUnits:{gte:result.reservedCreditUnits}},
        data:{creditBalanceUnits:{decrement:result.reservedCreditUnits}}});
      if (!changed.count) throw fail("Insufficient render credits.",402);
      const claimed = await tx.upload.updateMany({where:{key:input.inputKey,usedAt:null},data:{usedAt:new Date()}});
      if (!claimed.count) throw fail("This upload is already in use.",409);
      const created = await tx.renderJob.create({data:{licenseId:req.account.id,clientRequestId:requestId,inputKey:input.inputKey,
        outputKey,outputFilename:filename,receiptKey:outputKey + ".receipt.json",...selected,
        workflow:input.workflow,computeTier:input.computeTier,deadlineAt:new Date(Date.now()+86400000),
        comp:input.comp,options:input.options,pricing:result.pricing,reservedCreditUnits:result.reservedCreditUnits}});
      await tx.creditLedger.create({data:{licenseId:req.account.id,jobId:created.id,units:-result.reservedCreditUnits,
        kind:"JOB_RESERVATION",externalRef:"reserve:" + created.id,note:"Render and storage reservation"}});
      return created;
    });
    if (job.previous) return res.json(await view(job.previous));
    let dispatched = false;
    try {
      const payload = {job_id:job.id,comp:input.comp,options:input.options,output:result.output,
        input_url:await store.signedGet(job.inputKey,86400),
        output_url:await store.signedPut(job.outputKey,formats[input.options.format].mime,86400),
        receipt_url:await store.signedPut(job.receiptKey,"application/json",86400)};
      const queued = await cloud.request(job,"run",payload);
      dispatched = true;
      await db.renderJob.updateMany({where:{id:job.id,settledAt:null},data:{providerJobId:queued.id,status:"IN_QUEUE"}});
    } catch (error) {
      // A lost dispatch response must not cause a second paid render or a false refund.
      if (!dispatched && !error.uncertain) await settle(job,{status:"FAILED"});
    }
    const current = await db.renderJob.findUnique({where:{id:job.id}});
    const account = await db.license.findUnique({where:{id:req.account.id}});
    res.status(202).json({...await view(current),account:accountView(account)});
  }));
  app.get("/api/v1/jobs",requireAuth,route(async(req,res) => {
    const jobs = await db.renderJob.findMany({where:{licenseId:req.account.id},orderBy:{createdAt:"desc"},take:20});
    res.json({jobs:await Promise.all(jobs.map(view))});
  }));
  app.get("/api/v1/jobs/:id",requireAuth,route(async(req,res) => {
    let job = await db.renderJob.findFirst({where:{id:req.params.id,licenseId:req.account.id}});
    if (!job) throw fail("Render not found.",404);
    job = await refresh(job);
    const account = await db.license.findUnique({where:{id:req.account.id}});
    res.json({...await view(job),account:accountView(account)});
  }));
  app.post("/api/v1/jobs/:id/cancel",requireAuth,route(async(req,res) => {
    let job = await db.renderJob.findFirst({where:{id:req.params.id,licenseId:req.account.id}});
    if (!job) throw fail("Render not found.",404);
    if (!job.settledAt) {
      if (!job.providerJobId) throw fail("Submission is being reconciled. Cancellation is not yet available.",409);
      await cloud.request(job,"cancel");
      job = await refresh(job);
    }
    res.json(await view(job));
  }));
  const purchase = z.object({eventId:z.string().min(4).max(200),email:z.string().email().max(320),
    licenseKey:z.string().min(6).max(256).optional(),credits:z.coerce.number().min(.001).max(100000),
    productCode:z.string().max(200).optional(),maxDevices:z.coerce.number().int().min(1).max(10).optional()});
  app.post("/api/v1/webhooks/zapier/purchase",secret("ZAPIER_WEBHOOK_SECRET"),route(async(req,res) => {
    if (!auth.ready()) throw fail("License service is awaiting setup.",503);
    const input = purchase.parse(req.body), email = auth.normalizeEmail(input.email);
    const eventWhere = {source_externalId:{source:"zapier-payhip",externalId:input.eventId}};
    if (await db.webhookEvent.findUnique({where:eventWhere})) return res.json({ok:true,duplicate:true});
    try {
      const account = await db.$transaction(async tx => {
        await tx.webhookEvent.create({data:{source:"zapier-payhip",externalId:input.eventId,
          payload:{email,credits:input.credits,productCode:input.productCode || null}}});
        let license;
        if (input.licenseKey) {
          const keyHash = auth.licenseKeyHash(input.licenseKey);
          license = await tx.license.findUnique({where:{keyHash}});
          if (license && (license.email !== email || license.status !== "ACTIVE")) throw fail("License does not match an active purchaser.",409);
          if (!license) license = await tx.license.create({data:{email,keyHash,maxDevices:input.maxDevices || 2}});
        } else {
          const matches = await tx.license.findMany({where:{email,status:"ACTIVE"},take:2});
          if (matches.length !== 1) throw fail("Include licenseKey to identify the license for this purchase.",422);
          license = matches[0];
        }
        const units = Math.round(input.credits * 1000);
        await tx.creditLedger.create({data:{licenseId:license.id,units,kind:"PURCHASE",
          externalRef:"zapier:" + input.eventId,note:input.productCode || "Credit purchase"}});
        return tx.license.update({where:{id:license.id},data:{creditBalanceUnits:{increment:units}}});
      });
      res.json({ok:true,duplicate:false,creditBalanceUnits:account.creditBalanceUnits});
    } catch (error) {
      if (error.code === "P2002" && await db.webhookEvent.findUnique({where:eventWhere})) return res.json({ok:true,duplicate:true});
      throw error;
    }
  }));
  app.post("/api/v1/admin/devices/reset",secret("ADMIN_SECRET"),route(async(req,res) => {
    const input = z.object({licenseKey:z.string().min(6).max(256)}).parse(req.body);
    const license = await db.license.findUnique({where:{keyHash:auth.licenseKeyHash(input.licenseKey)}});
    if (!license) throw fail("License not found.",404);
    const changed = await db.device.updateMany({where:{licenseId:license.id,active:true},data:{active:false}});
    res.json({ok:true,deactivatedDevices:changed.count});
  }));
  app.get("/api/cron/reconcile",secret("CRON_SECRET"),route(async(_req,res) => {
    let reconciled = 0, purged = 0;
    const until = Date.now()+35000;
    const jobs = await db.renderJob.findMany({where:{settledAt:null},orderBy:{updatedAt:"asc"},take:25});
    for (const job of jobs) {
      if (Date.now() >= until) break;
      try { await refresh(job); reconciled++; }
      catch (_) { await db.renderJob.updateMany({where:{id:job.id,settledAt:null},data:{updatedAt:new Date()}}); }
    }
    const inputs = await db.renderJob.findMany({where:{settledAt:{not:null},inputPurgedAt:null},take:25});
    for (const job of inputs) try {
      if (Date.now() >= until) break;
      await store.remove(job.inputKey);
      await db.renderJob.update({where:{id:job.id},data:{inputPurgedAt:new Date()}});
    } catch (_) {}
    const expired = await db.renderJob.findMany({where:{settledAt:{not:null},purgedAt:null,expiresAt:{lte:new Date()}},take:25});
    for (const job of expired) try {
      if (Date.now() >= until) break;
      await store.remove(job.outputKey); await store.remove(job.receiptKey);
      await db.renderJob.update({where:{id:job.id},data:{purgedAt:new Date()}}); purged++;
    } catch (_) {}
    const abandoned = await db.upload.findMany({where:{usedAt:null,createdAt:{lt:new Date(Date.now()-86400000)}},take:25});
    for (const upload of abandoned) try { if (Date.now() >= until) break; await store.remove(upload.key); await db.upload.delete({where:{key:upload.key}}); } catch (_) {}
    res.json({ok:true,reconciled,purged});
  }));
  app.use((error,_req,res,_next) => {
    if (error instanceof z.ZodError) return res.status(400).json({error:error.issues.map(i=>i.message).join(" "),details:error.issues});
    if (error.statusCode) return res.status(error.statusCode).json({error:error.message});
    console.error("PocketEnvy request failed:",error.code || error.name || "unknown");
    res.status(503).json({error:"PocketEnvy service is temporarily unavailable. Try again shortly."});
  });
  return app;
}
module.exports = createApp();
module.exports.createApp = createApp;
