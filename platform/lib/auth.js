"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

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
  return jwt.verify(token, process.env.JWT_SECRET, { audience: "pocketenvy-panel", issuer: "pocketenvy-api" });
}
function safeEqual(a, b) {
  var left = Buffer.from(String(a || ""));
  var right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
module.exports = { sha256, normalizeEmail, licenseKeyHash, deviceHash, signSession, verifySession, safeEqual };
