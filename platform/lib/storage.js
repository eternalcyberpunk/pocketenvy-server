"use strict";
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
let client;
function storage() {
  if (!client) client = new S3Client({
    maxAttempts: 1, requestHandler: {connectionTimeout:3000, requestTimeout:5000},
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || "auto",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {accessKeyId:process.env.S3_ACCESS_KEY_ID, secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}
  });
  return client;
}
function object(key) { return { Bucket:process.env.S3_BUCKET, Key:key }; }
async function signedPut(key, type, ttl, size) {
  return getSignedUrl(storage(), new PutObjectCommand({...object(key), ContentType:type,
    ...(size ? {ContentLength:size} : {})}), {expiresIn:ttl,
    signableHeaders:new Set(size ? ["content-type","content-length"] : ["content-type"])});
}
async function signedGet(key, ttl) { return getSignedUrl(storage(), new GetObjectCommand(object(key)), {expiresIn:ttl}); }
async function head(key) {
  try { return await storage().send(new HeadObjectCommand(object(key))); }
  catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
}
async function readReceipt(key) {
  try {
    const result = await storage().send(new GetObjectCommand(object(key)));
    if (result.ContentLength > 32768) throw new Error("Receipt exceeds size limit.");
    return JSON.parse(await result.Body.transformToString());
  } catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
}
async function remove(key) { return storage().send(new DeleteObjectCommand(object(key))); }
module.exports = {signedPut, signedGet, head, readReceipt, remove};
