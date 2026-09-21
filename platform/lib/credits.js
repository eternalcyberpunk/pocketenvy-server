"use strict";
const { geometry } = require("./render-spec");
function num(value, fallback) { var n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function resolveInput(input = {}) {
  if (input && input.options && typeof input.options === "object")
    return { options: input.options, workflow: input.workflow || input.options.workflow, computeTier: input.computeTier || input.options.computeTier };
  return { options: input || {}, workflow: input?.workflow, computeTier: input?.computeTier };
}
function quote(comp, input, env = process.env) {
  const { options, workflow, computeTier } = resolveInput(input);
  const output = geometry(comp, options);
  const tier = computeTier || "STANDARD";
  const tierFactor = num(env["TIER_" + tier + "_MULTIPLIER"], {ECONOMY:.8,STANDARD:1,TURBO:1.6}[tier]);
  const workflowFactor = workflow === "FULL_PROJECT" ? num(env.FULL_PROJECT_CREDIT_MULTIPLIER, 2.5) : 1;
  const minimum = num(env.MIN_JOB_CREDIT_UNITS, 250);
  const retentionUnits = Math.ceil((options.retentionDays - 1) * num(env.RETENTION_CREDIT_UNITS_PER_DAY, 10));
  let factor = Math.max(1, output.fps / comp.fps);
  if (options.interpolate) factor *= 1.8;
  if (options.denoise) factor *= 1.12;
  if (options.sharpen) factor *= 1.06;
  factor *= {h264:1,hevc:1.15,av1:1.35,prores:1.2,vp9:1.4,png:1.3}[options.codec] || 1;
  factor *= .7 + options.quality / 100 * .4;
  const work = output.width * output.height / 1e6 * comp.duration * num(env.CREDIT_UNITS_PER_MP_SECOND, 8);
  const reserved = Math.ceil(Math.max(minimum, work * factor * workflowFactor * tierFactor *
    (1 + num(env.RESERVATION_SAFETY_PERCENT, 25) / 100)) + retentionUnits);
  if (!Number.isSafeInteger(reserved) || reserved > 2000000000) throw new Error("Estimate exceeds supported credit range.");
  return { reservedCreditUnits: reserved, output, pricing: {
    unitsPerMinute: Math.ceil(num(env.CREDIT_UNITS_PER_GPU_MINUTE,1000) * tierFactor * workflowFactor),
    minimum, retentionUnits } };
}
function estimateCreditUnits(comp, options, env) { return quote(comp, options, env).reservedCreditUnits; }
function actualCreditUnits(executionMs, reserved, pricing) {
  return Math.min(reserved, Math.ceil(Math.max(pricing.minimum, Math.max(0, executionMs) / 60000 * pricing.unitsPerMinute) + pricing.retentionUnits));
}
module.exports = { quote, estimateCreditUnits, actualCreditUnits };
