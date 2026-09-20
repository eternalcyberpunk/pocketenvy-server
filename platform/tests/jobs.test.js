"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

function mockModule(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exports
  };
}
function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}
async function withServer(app, run) {
  return new Promise(function (resolve, reject) {
    var server = app.listen(0, async function () {
      try {
        var port = server.address().port;
        resolve(await run("http://127.0.0.1:" + port));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}
function loadApp(overrides) {
  var root = path.resolve(__dirname, "..");
  var dbPath = path.join(root, "lib", "db.js");
  var authPath = path.join(root, "lib", "auth.js");
  var storagePath = path.join(root, "lib", "storage.js");
  var runpodPath = path.join(root, "lib", "runpod.js");
  var appPath = path.join(root, "api", "index.js");

  [appPath, dbPath, authPath, storagePath, runpodPath].forEach(clearModule);
  mockModule(dbPath, { prisma: overrides.prisma });
  mockModule(authPath, {
    normalizeEmail: function (value) { return String(value || "").trim().toLowerCase(); },
    licenseKeyHash: function () { return "hash"; },
    deviceHash: function () { return "device-hash"; },
    signSession: function () { return "token"; },
    verifySession: function () { return { sub: "lic_123", device: "device-hash" }; },
    safeEqual: function () { return true; }
  });
  mockModule(storagePath, {
    signedPut: overrides.signedPut || (async function () { return "https://example.com/upload"; }),
    signedGet: overrides.signedGet || (async function () { return "https://example.com/input"; }),
    remove: async function () {}
  });
  mockModule(runpodPath, { runpod: overrides.runpod || (async function () { return { id: "rp_123" }; }) });
  return require(appPath);
}

test("job submission accepts camelCase interpolateFps and queues a job", async function () {
  var license = { id: "lic_123", email: "customer@example.com", creditBalanceUnits: 4000, status: "ACTIVE", maxDevices: 2 };
  var runpodCall = null;
  var prisma = {
    device: {
      findFirst: async function () { return { id: "device_1", license: license }; },
      update: async function () {}
    },
    renderJob: {
      findUnique: async function () { return null; },
      count: async function () { return 0; },
      update: async function (_args) {
        return {
          id: "job_123",
          status: "IN_QUEUE",
          reservedCreditUnits: 1250,
          inputKey: "inputs/lic_123/source.mov",
          outputKey: "outputs/lic_123/result.mp4",
          outputFilename: "result.mp4"
        };
      }
    },
    license: {
      findUnique: async function () { return license; }
    },
    creditLedger: { create: async function () {} },
    $transaction: async function (handler) {
      return handler({
        license: {
          updateMany: async function () { return { count: 1 }; }
        },
        renderJob: {
          create: async function (_args) {
            return {
              id: "job_123",
              licenseId: "lic_123",
              reservedCreditUnits: 1250,
              inputKey: "inputs/lic_123/source.mov",
              outputKey: "outputs/lic_123/result.mp4",
              outputFilename: "result.mp4",
              options: { codec: "h264", quality: 20, upscale: 1, interpolate_fps: 60, denoise: false, sharpen: true }
            };
          }
        },
        creditLedger: { create: async function () {} }
      });
    }
  };
  var app = loadApp({
    prisma: prisma,
    runpod: async function (route, options) {
      runpodCall = { route: route, options: options };
      return { id: "rp_123" };
    }
  });

  await withServer(app, async function (baseUrl) {
    var response = await fetch(baseUrl + "/api/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: ["Bearer", "test-token"].join(" "),
        "Content-Type": "application/json",
        "Idempotency-Key": "1234567890abcdef"
      },
      body: JSON.stringify({
        inputKey: "inputs/lic_123/source.mov",
        outputFilename: "result.mov",
        comp: { width: 1920, height: 1080, duration: 60, fps: 30, name: "Main comp" },
        options: { codec: "h264", quality: 20, upscale: 1, interpolateFps: 60, denoise: false, sharpen: true }
      })
    });
    var body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.jobId, "job_123");
    assert.equal(body.status, "IN_QUEUE");
    assert.equal(body.account.email, "customer@example.com");
    assert.equal(runpodCall.route, "/run");
    assert.equal(JSON.parse(runpodCall.options.body).input.options.interpolate_fps, 60);
    assert.equal("interpolateFps" in JSON.parse(runpodCall.options.body).input.options, false);
  });
});

test("job submission rejects malformed snake_case interpolation payloads", async function () {
  var app = loadApp({
    prisma: {
      device: {
        findFirst: async function () {
          return { id: "device_1", license: { id: "lic_123", email: "customer@example.com", creditBalanceUnits: 4000, status: "ACTIVE", maxDevices: 2 } };
        },
        update: async function () {}
      }
    }
  });

  await withServer(app, async function (baseUrl) {
    var response = await fetch(baseUrl + "/api/v1/jobs", {
      method: "POST",
      headers: {
        Authorization: ["Bearer", "test-token"].join(" "),
        "Content-Type": "application/json",
        "Idempotency-Key": "1234567890abcdef"
      },
      body: JSON.stringify({
        inputKey: "inputs/lic_123/source.mov",
        outputFilename: "result.mov",
        comp: { width: 1920, height: 1080, duration: 60, fps: 30 },
        options: { codec: "h264", quality: 20, upscale: 1, interpolate_fps: 60, denoise: false, sharpen: true }
      })
    });
    var body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "Invalid request payload.");
  });
});
