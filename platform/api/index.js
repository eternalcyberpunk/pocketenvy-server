"use strict";
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { z } = require("zod");
const { prisma } = require("../lib/db");
const { normalizeEmail, licenseKeyHash, deviceHash, signSession, verifySession, safeEqual } = require("../lib/auth");
const { estimateCreditUnits, actualCreditUnits } = require("../lib/credits");
const { signedPut, signedGet, remove } = require("../lib/storage");
const { runpod } = require("../lib/runpod");

const app = express();
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 ** 3);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_JOBS || 2);
const uploadTtl = Number(process.env.UPLOAD_URL_TTL_SECONDS || 3600);
const downloadTtl = Number(process.env.DOWNLOAD_URL_TTL_SECONDS || 3600);
const runpodUrlTtl = Number(process.env.RUNPOD_INPUT_URL_TTL_SECONDS || 21600);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "null").split(",").map(function (v) { return v.trim(); });

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: function (origin, callback) {
  if (!origin || origin === "null" || allowedOrigins.includes(origin)) return callback(null, true);
  callback(new Error("Origin is not allowed."));
} }));
app.use(express.json({ limit: "128kb" }));

function safeFilename(value, fallback) {
  var clean = path.basename(String(value || fallback)).replace(/[^a-zA-Z0-9._-]/g, "_");
  return clean.slice(0, 180) || fallback;
}
function accountView(license) {
  return { email: license.email, creditBalanceUnits: license.creditBalanceUnits, status: license.status, maxDevices: license.maxDevices };
}
function asyncRoute(handler) {
  return function (request, response, next) { Promise.resolve(handler(request, response, next)).catch(next); };
}

async function requireAuth(request, response, next) {
  try {
    var header = String(request.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return response.status(401).json({ error: "Activation required." });
    var payload = verifySession(header.slice(7));
    var device = await prisma.device.findFirst({
      where: { licenseId: payload.sub, deviceHash: payload.device, active: true }, include: { license: true }
    });
    if (!device || device.license.status !== "ACTIVE") return response.status(401).json({ error: "License session is no longer active." });
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    request.auth = { license: device.license, device: device };
    next();
  } catch (_) { response.status(401).json({ error: "License session expired. Activate again." }); }
}

const activationSchema = z.object({
  email: z.string().email().max(320), licenseKey: z.string().min(6).max(256),
  deviceId: z.string().min(16).max(128), deviceName: z.string().max(120).optional()
});
app.post("/api/v1/license/activate", asyncRoute(async function (request, response) {
  var input = activationSchema.parse(request.body);
  var email = normalizeEmail(input.email);
  var keyHash = licenseKeyHash(input.licenseKey);
  var license = await prisma.license.findUnique({ where: { keyHash: keyHash } });
  if (!license || normalizeEmail(license.email) !== email || license.status !== "ACTIVE") {
    return response.status(401).json({ error: "Email or license key is invalid." });
  }
  var hash = deviceHash(input.deviceId);
  var existing = await prisma.device.findUnique({ where: { licenseId_deviceHash: { licenseId: license.id, deviceHash: hash } } });
  if (!existing) {
    var activeCount = await prisma.device.count({ where: { licenseId: license.id, active: true } });
    if (activeCount >= license.maxDevices) return response.status(409).json({ error: "Device limit reached. Contact support to reset an activation." });
  }
  await prisma.device.upsert({
    where: { licenseId_deviceHash: { licenseId: license.id, deviceHash: hash } },
    create: { licenseId: license.id, deviceHash: hash, name: input.deviceName || null },
    update: { active: true, name: input.deviceName || undefined, lastSeenAt: new Date() }
  });
  response.json({ token: signSession(license.id, hash), account: accountView(license) });
}));

app.get("/api/health", function (_request, response) {
  response.json({ ok: true, service: "pocketenvy-api", version: "1.0.0" });
});
app.get("/api/v1/me", requireAuth, asyncRoute(async function (request, response) {
  var license = await prisma.license.findUnique({ where: { id: request.auth.license.id } });
  response.json(accountView(license));
}));

const uploadSchema = z.object({
  filename: z.string().min(1).max(180), contentType: z.string().min(1).max(100),
  fileSizeBytes: z.number().int().positive()
});
app.post("/api/v1/uploads", requireAuth, asyncRoute(async function (request, response) {
  var input = uploadSchema.parse(request.body);
  if (input.fileSizeBytes > MAX_UPLOAD) return response.status(413).json({ error: "Master exceeds the upload limit." });
  var filename = safeFilename(input.filename, "master.mov");
  var key = "inputs/" + request.auth.license.id + "/" + crypto.randomUUID() + "-" + filename;
  response.status(201).json({
    inputKey: key,
    uploadUrl: await signedPut(key, input.contentType, uploadTtl),
    expiresIn: uploadTtl
  });
}));

const jobSchema = z.object({
  inputKey: z.string().min(10).max(500), outputFilename: z.string().min(1).max(180),
  comp: z.object({ width: z.number().positive(), height: z.number().positive(), duration: z.number().positive(), fps: z.number().positive(), name: z.string().max(300).optional() }),
  options: z.object({
    codec: z.enum(["h264", "hevc", "av1"]), quality: z.number().int().min(12).max(32),
    upscale: z.union([z.literal(1), z.literal(2)]), interpolateFps: z.union([z.literal(60), z.null()]),
    denoise: z.boolean(), sharpen: z.boolean()
  })
});

async function refundDispatchFailure(jobId, message) {
  return prisma.$transaction(async function (tx) {
    var job = await tx.renderJob.findUnique({ where: { id: jobId } });
    if (!job || job.settledAt) return;
    await tx.license.update({ where: { id: job.licenseId }, data: { creditBalanceUnits: { increment: job.reservedCreditUnits } } });
    await tx.creditLedger.create({ data: { licenseId: job.licenseId, jobId: job.id, units: job.reservedCreditUnits, kind: "JOB_REFUND", note: "Dispatch failed" } });
    await tx.renderJob.update({ where: { id: job.id }, data: { status: "FAILED", error: String(message).slice(0, 2000), settledCreditUnits: 0, settledAt: new Date() } });
  });
}

app.post("/api/v1/jobs", requireAuth, asyncRoute(async function (request, response) {
  var input = jobSchema.parse(request.body);
  var clientRequestId = String(request.headers["idempotency-key"] || "");
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientRequestId)) return response.status(400).json({ error: "A valid Idempotency-Key header is required." });
  var licenseId = request.auth.license.id;
  if (!input.inputKey.startsWith("inputs/" + licenseId + "/")) return response.status(400).json({ error: "Input does not belong to this account." });
  var duplicate = await prisma.renderJob.findUnique({ where: { licenseId_clientRequestId: { licenseId: licenseId, clientRequestId: clientRequestId } } });
  if (duplicate) return response.json({ jobId: duplicate.id, status: duplicate.status, reservedCreditUnits: duplicate.reservedCreditUnits, account: accountView(request.auth.license) });
  var activeCount = await prisma.renderJob.count({ where: { licenseId: licenseId, status: { in: ["RESERVED", "IN_QUEUE", "IN_PROGRESS"] } } });
  if (activeCount >= MAX_ACTIVE) return response.status(429).json({ error: "Active render limit reached. Wait for a job to finish." });

  var reservedUnits = estimateCreditUnits(input.comp, input.options);
  var outputFilename = safeFilename(input.outputFilename, "pocketenvy.mp4").replace(/\.[^.]+$/, "") + ".mp4";
  var outputKey = "outputs/" + licenseId + "/" + crypto.randomUUID() + "-" + outputFilename;
  var job;
  try {
    job = await prisma.$transaction(async function (tx) {
      var changed = await tx.license.updateMany({ where: { id: licenseId, status: "ACTIVE", creditBalanceUnits: { gte: reservedUnits } }, data: { creditBalanceUnits: { decrement: reservedUnits } } });
      if (!changed.count) throw Object.assign(new Error("Insufficient render credits."), { statusCode: 402 });
      var created = await tx.renderJob.create({ data: { licenseId: licenseId, clientRequestId: clientRequestId, inputKey: input.inputKey,
        outputKey: outputKey, outputFilename: outputFilename, reservedCreditUnits: reservedUnits, comp: input.comp, options: input.options } });
      await tx.creditLedger.create({ data: { licenseId: licenseId, jobId: created.id, units: -reservedUnits, kind: "JOB_RESERVATION", note: "Render reservation" } });
      return created;
    });
  } catch (error) {
    if (error.statusCode === 402) return response.status(402).json({ error: error.message, requiredCreditUnits: reservedUnits });
    throw error;
  }

  try {
    var inputUrl = await signedGet(job.inputKey, runpodUrlTtl);
    var outputUrl = await signedPut(job.outputKey, "video/mp4", runpodUrlTtl);
    var queued = await runpod("/run", { method: "POST", body: JSON.stringify({ input: {
      input_url: inputUrl, output_url: outputUrl, output_filename: outputFilename,
      options: { codec: input.options.codec, quality: input.options.quality, upscale: input.options.upscale,
        interpolate_fps: input.options.interpolateFps, denoise: input.options.denoise, sharpen: input.options.sharpen }
    } }) });
    job = await prisma.renderJob.update({ where: { id: job.id }, data: { runpodJobId: queued.id, status: "IN_QUEUE" } });
  } catch (error) {
    await refundDispatchFailure(job.id, error.message);
    return response.status(502).json({ error: "Cloud worker could not be started; credits were refunded." });
  }
  var license = await prisma.license.findUnique({ where: { id: licenseId } });
  response.status(202).json({ jobId: job.id, status: job.status, reservedCreditUnits: reservedUnits, account: accountView(license) });
}));

async function settle(job, runpodStatus) {
  var terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(runpodStatus.status);
  if (!terminal) {
    var mapped = runpodStatus.status === "IN_PROGRESS" ? "IN_PROGRESS" : "IN_QUEUE";
    return prisma.renderJob.update({ where: { id: job.id }, data: { status: mapped } });
  }
  if (job.settledAt) return job;
  return prisma.$transaction(async function (tx) {
    var fresh = await tx.renderJob.findUnique({ where: { id: job.id } });
    if (fresh.settledAt) return fresh;
    var completed = runpodStatus.status === "COMPLETED";
    var executionMs = Number(runpodStatus.executionTime || 0);
    var actual = completed ? actualCreditUnits(executionMs, fresh.reservedCreditUnits) : 0;
    var refund = fresh.reservedCreditUnits - actual;
    if (refund > 0) {
      await tx.license.update({ where: { id: fresh.licenseId }, data: { creditBalanceUnits: { increment: refund } } });
      await tx.creditLedger.create({ data: { licenseId: fresh.licenseId, jobId: fresh.id, units: refund,
        kind: completed ? "JOB_SETTLEMENT" : "JOB_REFUND", note: completed ? "Unused reservation returned" : "Failed job refunded" } });
    }
    return tx.renderJob.update({ where: { id: fresh.id }, data: { status: runpodStatus.status, settledCreditUnits: actual,
      runpodExecutionTimeMs: executionMs, error: runpodStatus.error ? JSON.stringify(runpodStatus.error).slice(0, 2000) : null, settledAt: new Date() } });
  });
}

async function refreshJob(job) {
  if (!job.runpodJobId || job.settledAt) return job;
  var status = await runpod("/status/" + encodeURIComponent(job.runpodJobId));
  var settled = await settle(job, status);
  if (settled.status === "COMPLETED") remove(settled.inputKey).catch(function () {});
  return settled;
}

app.get("/api/v1/jobs/:jobId", requireAuth, asyncRoute(async function (request, response) {
  var job = await prisma.renderJob.findFirst({ where: { id: request.params.jobId, licenseId: request.auth.license.id } });
  if (!job) return response.status(404).json({ error: "Render job not found." });
  job = await refreshJob(job);
  var result = { jobId: job.id, status: job.status, reservedCreditUnits: job.reservedCreditUnits,
    settledCreditUnits: job.settledCreditUnits, error: job.error };
  if (job.status === "COMPLETED") result.downloadUrl = await signedGet(job.outputKey, downloadTtl);
  var license = await prisma.license.findUnique({ where: { id: job.licenseId } });
  result.account = accountView(license);
  response.json(result);
}));

app.post("/api/v1/jobs/:jobId/cancel", requireAuth, asyncRoute(async function (request, response) {
  var job = await prisma.renderJob.findFirst({ where: { id: request.params.jobId, licenseId: request.auth.license.id } });
  if (!job) return response.status(404).json({ error: "Render job not found." });
  if (job.runpodJobId && !job.settledAt) await runpod("/cancel/" + encodeURIComponent(job.runpodJobId), { method: "POST" });
  job = await settle(job, { status: "CANCELLED", error: "Cancelled by customer" });
  response.json({ jobId: job.id, status: job.status });
}));

const purchaseSchema = z.object({
  eventId: z.string().min(4).max(200), email: z.string().email().max(320),
  licenseKey: z.string().min(6).max(256).optional(), credits: z.number().positive().max(100000),
  productCode: z.string().max(200).optional(), maxDevices: z.number().int().min(1).max(10).optional()
});
app.post("/api/v1/webhooks/zapier/purchase", asyncRoute(async function (request, response) {
  var bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(bearer, process.env.ZAPIER_WEBHOOK_SECRET)) return response.status(401).json({ error: "Unauthorized webhook." });
  var input = purchaseSchema.parse(request.body);
  var email = normalizeEmail(input.email);
  var units = Math.round(input.credits * 1000);
  try {
    var result = await prisma.$transaction(async function (tx) {
      await tx.webhookEvent.create({ data: { source: "zapier-payhip", externalId: input.eventId,
        payload: { email: email, credits: input.credits, productCode: input.productCode || null } } });
      var license;
      if (input.licenseKey) {
        var hash = licenseKeyHash(input.licenseKey);
        license = await tx.license.upsert({ where: { keyHash: hash },
          create: { email: email, keyHash: hash, maxDevices: input.maxDevices || 2 },
          update: { email: email, status: "ACTIVE", maxDevices: input.maxDevices || undefined } });
      } else {
        license = await tx.license.findFirst({ where: { email: email, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
        if (!license) throw Object.assign(new Error("No active license exists for this email; include licenseKey."), { statusCode: 422 });
      }
      license = await tx.license.update({ where: { id: license.id }, data: { creditBalanceUnits: { increment: units } } });
      await tx.creditLedger.create({ data: { licenseId: license.id, units: units, kind: "PURCHASE",
        externalRef: "zapier:" + input.eventId, note: input.productCode || "Payhip credit purchase" } });
      return license;
    });
    response.json({ ok: true, duplicate: false, creditBalanceUnits: result.creditBalanceUnits });
  } catch (error) {
    if (error.code === "P2002") return response.json({ ok: true, duplicate: true });
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    throw error;
  }
}));

const resetSchema = z.object({
  email: z.string().email().max(320).optional(), licenseKey: z.string().min(6).max(256).optional()
}).refine(function (value) { return Boolean(value.email || value.licenseKey); }, { message: "Email or licenseKey is required." });
app.post("/api/v1/admin/devices/reset", asyncRoute(async function (request, response) {
  var bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(bearer, process.env.ADMIN_SECRET)) return response.status(401).json({ error: "Unauthorized admin request." });
  var input = resetSchema.parse(request.body);
  var license = input.licenseKey
    ? await prisma.license.findUnique({ where: { keyHash: licenseKeyHash(input.licenseKey) } })
    : await prisma.license.findFirst({ where: { email: normalizeEmail(input.email) }, orderBy: { createdAt: "asc" } });
  if (!license) return response.status(404).json({ error: "License not found." });
  var result = await prisma.device.updateMany({ where: { licenseId: license.id, active: true }, data: { active: false } });
  response.json({ ok: true, deactivatedDevices: result.count, email: license.email });
}));

app.get("/api/cron/reconcile", asyncRoute(async function (request, response) {
  var bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(bearer, process.env.CRON_SECRET)) return response.status(401).json({ error: "Unauthorized cron." });
  var jobs = await prisma.renderJob.findMany({ where: { status: { in: ["IN_QUEUE", "IN_PROGRESS"] }, settledAt: null }, orderBy: { updatedAt: "asc" }, take: 25 });
  var results = [];
  for (var job of jobs) {
    try { var current = await refreshJob(job); results.push({ id: job.id, status: current.status }); }
    catch (error) { results.push({ id: job.id, error: error.message }); }
  }
  response.json({ ok: true, checked: results.length, results: results });
}));

app.use(function (error, _request, response, _next) {
  if (error instanceof z.ZodError) return response.status(400).json({ error: "Invalid request payload.", details: error.issues });
  console.error(error);
  response.status(500).json({ error: "Unexpected PocketEnvy service error." });
});

module.exports = app;
