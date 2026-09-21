(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PocketEnvyOptions = factory();
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  var formats = {
    mp4: { extension: "mp4", mime: "video/mp4", codecs: ["h264", "hevc", "av1"] },
    mov: { extension: "mov", mime: "video/quicktime", codecs: ["h264", "hevc", "prores"] },
    webm: { extension: "webm", mime: "video/webm", codecs: ["vp9", "av1"] },
    png_sequence: { extension: "zip", mime: "application/zip", codecs: ["png"] }
  };
  function even(value) { return Math.max(2, Math.round(value / 2) * 2); }
  function geometry(comp, options) {
    var ratio = comp.width * (comp.pixelAspect || 1) / comp.height;
    if (options.aspectRatio !== "source") {
      var parts = options.aspectRatio.split(":"); ratio = Number(parts[0]) / Number(parts[1]);
    }
    var side = { "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160 }[options.resolution];
    if (!side) side = Math.min(comp.width * (comp.pixelAspect || 1), comp.height);
    var scale = Number(options.upscale || 1);
    return { width: even(side * (ratio >= 1 ? ratio : 1) * scale),
      height: even(side * (ratio >= 1 ? 1 : 1 / ratio) * scale),
      fps: Number(options.targetFps) || comp.fps };
  }
  return { formats: formats, geometry: geometry, maxDimension: 8192 };
});
