"use strict";
function number(value, fallback) { var parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function estimateCreditUnits(comp, options, env) {
  env = env || process.env;
  var width = Math.max(16, Math.min(16384, number(comp.width, 1920)));
  var height = Math.max(16, Math.min(16384, number(comp.height, 1080)));
  var duration = Math.max(0.04, Math.min(86400, number(comp.duration, 1)));
  var mpSeconds = (width * height / 1000000) * duration;
  var factor = 1;
  if (number(options.upscale, 1) === 2) factor *= 4;
  if (number(options.interpolateFps != null ? options.interpolateFps : options.interpolate_fps, 0) === 60) factor *= 1.8;
  if (options.denoise === true) factor *= 1.12;
  if (options.sharpen === true) factor *= 1.06;
  if (options.codec === "hevc") factor *= 1.15;
  if (options.codec === "av1") factor *= 1.35;
  var raw = mpSeconds * number(env.CREDIT_UNITS_PER_MP_SECOND, 8) * factor;
  var safe = raw * (1 + number(env.RESERVATION_SAFETY_PERCENT, 25) / 100);
  return Math.max(number(env.MIN_JOB_CREDIT_UNITS, 250), Math.ceil(safe));
}
function actualCreditUnits(executionTimeMs, reserved, env) {
  env = env || process.env;
  var minutes = Math.max(0, number(executionTimeMs, 0)) / 60000;
  var calculated = Math.max(number(env.MIN_JOB_CREDIT_UNITS, 250), Math.ceil(minutes * number(env.CREDIT_UNITS_PER_GPU_MINUTE, 1000)));
  return Math.min(Math.max(0, reserved), calculated);
}
module.exports = { estimateCreditUnits, actualCreditUnits };
