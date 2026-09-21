"use strict";
const { z } = require("zod");
const spec = require("./render-spec");
const compSchema = z.object({
  id: z.number().int().positive().optional(), name: z.string().min(1).max(300),
  width: z.number().int().min(16).max(16384), height: z.number().int().min(16).max(16384),
  fps: z.number().min(1).max(120), duration: z.number().positive().max(7200),
  pixelAspect: z.number().min(0.1).max(10).default(1), aeVersion: z.string().max(80).optional()
});
const optionsSchema = z.object({
  format: z.enum(["mp4","mov","webm","png_sequence"]), codec: z.enum(["h264","hevc","av1","prores","vp9","png"]),
  quality: z.number().int().min(1).max(100), resolution: z.enum(["source","720p","1080p","1440p","2160p"]),
  aspectRatio: z.enum(["source","16:9","9:16","1:1","4:5"]),
  targetFps: z.union([z.literal(0),z.literal(24),z.literal(30),z.literal(60),z.literal(120)]),
  interpolate: z.boolean(), upscale: z.union([z.literal(1),z.literal(2),z.literal(4)]),
  denoise: z.boolean(), sharpen: z.boolean(),
  retentionDays: z.union([z.literal(1),z.literal(3),z.literal(7),z.literal(30)])
});
const base = z.object({ workflow: z.enum(["CLOUD_FINISH","FULL_PROJECT"]),
  computeTier: z.enum(["ECONOMY","STANDARD","TURBO"]), comp: compSchema, options: optionsSchema });
function validate(input, ctx) {
  if (!spec.formats[input.options.format].codecs.includes(input.options.codec))
    ctx.addIssue({ code: "custom", path: ["options","codec"], message: "Choose a codec supported by this format." });
  var output = spec.geometry(input.comp, input.options);
  if (Math.max(output.width, output.height) > spec.maxDimension)
    ctx.addIssue({ code: "custom", path: ["options","upscale"], message: "Output exceeds 8192 pixels on one side. Lower resolution or upscale." });
  if (input.options.interpolate && output.fps <= input.comp.fps)
    ctx.addIssue({ code: "custom", path: ["options","targetFps"], message: "Interpolation needs a frame rate higher than the source." });
}
module.exports = { ...spec, estimateSchema: base.superRefine(validate),
  jobSchema: base.extend({ inputKey: z.string().max(500),
    outputFilename: z.string().min(1).max(180) }).superRefine(validate) };
