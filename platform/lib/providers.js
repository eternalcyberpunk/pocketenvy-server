"use strict";
const tiers = ["ECONOMY","STANDARD","TURBO"];
function configured(value) { return !!value && !/replace_me|YOUR_|example\.com|generate_|ACCOUNT_ID/i.test(value); }
function route(workflow, tier) {
  if (!tiers.includes(tier)) return null;
  if (workflow === "FULL_PROJECT") {
    if (process.env.ENABLE_FULL_PROJECT !== "true" || !configured(process.env.AE_FARM_API_KEY)) return null;
    const value = process.env["AE_FARM_" + tier + "_URL"] || (tier === "STANDARD" ? process.env.AE_FARM_BASE_URL : "");
    if (!configured(value)) return null;
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return {provider:"AE_FARM", providerLocation:value.replace(/\/$/, "")};
  }
  const endpoint = process.env["RUNPOD_ENDPOINT_" + tier];
  if (!configured(endpoint) || !configured(process.env.RUNPOD_API_KEY) || !/^[a-zA-Z0-9_-]+$/.test(endpoint)) return null;
  return {provider:"RUNPOD", providerLocation:endpoint};
}
function capabilities() {
  const storageReady = ["S3_ENDPOINT","S3_BUCKET","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY"].every(key => configured(process.env[key]));
  return Object.fromEntries(["CLOUD_FINISH","FULL_PROJECT"].map(workflow => [workflow, tiers.filter(t => storageReady && route(workflow,t))]));
}
async function request(job, action, payload) {
  const farm = job.provider === "AE_FARM";
  const base = farm ? job.providerLocation : "https://api.runpod.ai/v2/" + job.providerLocation;
  const id = encodeURIComponent(job.providerJobId || "");
  const suffix = action === "run" ? (farm ? "/v1/jobs" : "/run") :
    action === "cancel" ? (farm ? "/v1/jobs/" + id + "/cancel" : "/cancel/" + id) :
    (farm ? "/v1/jobs/" + id : "/status/" + id);
  let body;
  if (payload) body = farm ? payload : {input:payload,
    policy:{executionTimeout:21600000, ttl:86400000}};
  let response;
  try {
    response = await fetch(base + suffix, { method:action === "status" ? "GET" : "POST",
      headers:{Authorization:"Bearer " + (farm ? process.env.AE_FARM_API_KEY : process.env.RUNPOD_API_KEY),
        "Content-Type":"application/json", "Idempotency-Key":job.id},
      body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(10000)});
  } catch (error) { throw Object.assign(new Error("Cloud service connection interrupted."), {uncertain:true}); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error("Cloud service returned HTTP " + response.status),
    {httpStatus:response.status, uncertain:action === "run" && response.status >= 500});
  if (action === "run" && !data.id) throw Object.assign(new Error("Cloud submission response was incomplete."), {uncertain:true});
  return data;
}
module.exports = {route, capabilities, request};
