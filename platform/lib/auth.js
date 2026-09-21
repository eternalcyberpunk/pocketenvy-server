"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function ready() { return ["JWT_SECRET","LICENSE_KEY_PEPPER"].every(k => (process.env[k] || "").length >= 32 && !/generate_|replace_me/.test(process.env[k])); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function licenseKeyHash(key) { return sha256(String(key || "").trim() + ":" + process.env.LICENSE_KEY_PEPPER); }
function deviceHash(id) { return sha256(String(id || "").trim() + ":device:" + process.env.LICENSE_KEY_PEPPER); }
function signSession(licenseId, deviceIdHash) {
  return jwt.sign({ sub: licenseId, device: deviceIdHash, aud: "pocketenvy-panel" }, process.env.JWT_SECRET, {
    expiresIn: process.env.SESSION_TTL || "30d", issuer: "pocketenvy-api"
  });
}
function verifySession(token) {
  if (!ready()) throw new Error("Session service is not configured.");
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"], audience: "pocketenvy-panel", issuer: "pocketenvy-api" });
}
function safeEqual(a, b) {
  var left = Buffer.from(String(a || ""));
  var right = Buffer.from(String(b || ""));
  return !/generate_|replace_me/i.test(String(b || "")) && right.length >= 32 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
module.exports = { ready, sha256, normalizeEmail, licenseKeyHash, deviceHash, signSession, verifySession, safeEqual };
