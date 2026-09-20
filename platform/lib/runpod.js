"use strict";
async function runpod(route, options) {
  var response = await fetch("https://api.runpod.ai/v2/" + process.env.RUNPOD_ENDPOINT_ID + route, {
    ...(options || {}),
    headers: { Authorization: "Bearer " + process.env.RUNPOD_API_KEY, "Content-Type": "application/json", ...((options && options.headers) || {}) }
  });
  var body = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(body.error || ("RunPod HTTP " + response.status));
  return body;
}
module.exports = { runpod };
