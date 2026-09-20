"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateCreditUnits, actualCreditUnits } = require("../lib/credits");
const env = { CREDIT_UNITS_PER_MP_SECOND: "8", CREDIT_UNITS_PER_GPU_MINUTE: "1000", MIN_JOB_CREDIT_UNITS: "250", RESERVATION_SAFETY_PERCENT: "25" };

test("baseline 1080p minute reserves near one credit plus safety", function () {
  var units = estimateCreditUnits({ width: 1920, height: 1080, duration: 60 }, { codec: "h264", upscale: 1 }, env);
  assert.ok(units >= 1200 && units <= 1300);
});
test("2x upscale materially increases reservation", function () {
  var base = estimateCreditUnits({ width: 1920, height: 1080, duration: 60 }, { codec: "h264", upscale: 1 }, env);
  var upscale = estimateCreditUnits({ width: 1920, height: 1080, duration: 60 }, { codec: "h264", upscale: 2 }, env);
  assert.ok(upscale >= base * 3.9);
});
test("actual charge never exceeds reservation", function () {
  assert.equal(actualCreditUnits(600000, 1200, env), 1200);
});
