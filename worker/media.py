"""Shared, bounded finishing pipeline used by the GPU and After Effects workers."""
from __future__ import annotations
import json
import math
import os
import subprocess
import zipfile
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlsplit
import requests

FORMATS = {
    "mp4": ("mp4", "video/mp4", {"h264", "hevc", "av1"}),
    "mov": ("mov", "video/quicktime", {"h264", "hevc", "prores"}),
    "webm": ("webm", "video/webm", {"vp9", "av1"}),
    "png_sequence": ("zip", "application/zip", {"png"}),
}
MAX_BYTES = min(int(os.getenv("MAX_TRANSFER_BYTES", str(4 * 1024**3))), 4 * 1024**3)
FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.getenv("FFPROBE_PATH", "ffprobe")

def storage_url(value):
    parsed = urlsplit(str(value))
    hosts = {v.strip().lower() for v in os.getenv("STORAGE_HOSTS", "").split(",") if v.strip()}
    if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None, 443):
        raise ValueError("Storage URL must match the configured HTTPS storage host.")
    return str(value)

def download(url, target):
    total = 0
    with requests.get(storage_url(url), stream=True, allow_redirects=False, timeout=(20, 120)) as response:
        if response.status_code != 200: raise RuntimeError("Input transfer failed (HTTP %s)." % response.status_code)
        if int(response.headers.get("content-length", "0")) > MAX_BYTES: raise ValueError("Input exceeds transfer limit.")
        with Path(target).open("wb") as output:
            for chunk in response.iter_content(1024**2):
                total += len(chunk)
                if total > MAX_BYTES: raise ValueError("Input exceeds transfer limit.")
                output.write(chunk)
    if not total: raise ValueError("Input file is empty.")
    return total

def upload(url, source, content_type):
    size = Path(source).stat().st_size
    if not 0 < size <= MAX_BYTES: raise ValueError("Output exceeds the 4 GiB transfer limit.")
    with Path(source).open("rb") as stream:
        response = requests.put(storage_url(url), data=stream, allow_redirects=False,
            headers={"Content-Type": content_type, "Content-Length": str(size)}, timeout=(20, 120))
    if not 200 <= response.status_code < 300: raise RuntimeError("Output transfer failed (HTTP %s)." % response.status_code)

def receipt(url, result):
    response = requests.put(storage_url(url), data=json.dumps(result).encode("utf-8"), allow_redirects=False,
        headers={"Content-Type": "application/json"}, timeout=(10, 30))
    if not 200 <= response.status_code < 300: raise RuntimeError("Could not persist job receipt.")

def geometry(comp, options):
    ratio = comp["width"] * comp.get("pixelAspect", 1) / comp["height"]
    if options["aspectRatio"] != "source":
        a, b = map(int, options["aspectRatio"].split(":"))
        ratio = a / b
    side = {"720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160}.get(options["resolution"])
    if side is None: side = min(comp["width"] * comp.get("pixelAspect", 1), comp["height"])
    def even(v): return max(2, math.floor(v / 2 + .5) * 2)
    scale = options["upscale"]
    return {"width": even(side * (ratio if ratio >= 1 else 1) * scale),
        "height": even(side * (1 if ratio >= 1 else 1 / ratio) * scale),
        "fps": options["targetFps"] or comp["fps"]}

def probe(source):
    result = subprocess.run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)],
        capture_output=True, text=True, timeout=30, check=True)
    data = json.loads(result.stdout)
    video = next((v for v in data["streams"] if v["codec_type"] == "video"), None)
    if not video: raise ValueError("Input has no video stream.")
    rate = float(Fraction(video.get("avg_frame_rate", "0/1")))
    duration = float(video.get("duration") or data["format"].get("duration") or 0)
    return {"width": video["width"], "height": video["height"], "fps": rate, "duration": duration,
        "audio": any(v["codec_type"] == "audio" for v in data["streams"])}

def validate_payload(payload):
    options, comp = payload["options"], payload["comp"]
    fmt = FORMATS.get(options["format"])
    if not fmt or options["codec"] not in fmt[2]: raise ValueError("Unsupported format and codec combination.")
    if options["upscale"] not in (1, 2, 4) or options["retentionDays"] not in (1, 3, 7, 30): raise ValueError("Unsupported render options.")
    if not 1 <= options["quality"] <= 100: raise ValueError("Quality must be between 1 and 100.")
    if not 0 < comp["duration"] <= 7200: raise ValueError("Maximum composition duration is two hours.")
    output = geometry(comp, options)
    if max(output["width"], output["height"]) > 8192 or not 1 <= output["fps"] <= 120: raise ValueError("Output exceeds supported dimensions or frame rate.")
    if options["interpolate"] and output["fps"] <= comp["fps"]: raise ValueError("Interpolation requires a higher frame rate.")
    return output

def filters(options, output):
    w, h, fps = output["width"], output["height"], output["fps"]
    # Fit preserves the image; changing aspect adds a centered black border.
    result = ["scale=trunc(iw*sar/2+0.5)*2:ih:flags=lanczos", "setsar=1", "scale=%s:%s:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos" % (w,h),
        "pad=%s:%s:(ow-iw)/2:(oh-ih)/2:black" % (w,h), "setsar=1"]
    if options["denoise"]: result.append("hqdn3d=1.5:1.5:6:6")
    if options["sharpen"]: result.append("unsharp=5:5:0.5:3:3:0.2")
    if options["interpolate"]: result.append("tpad=stop_mode=clone:stop_duration=1,minterpolate=fps=%s:mi_mode=mci:mc_mode=aobmc:me_mode=bidir" % fps)
    else: result.append("fps=%s" % fps)
    return result

def encoding(codec, quality):
    q = max(12, min(32, round(34 - quality * .22)))
    if codec == "prores":
        return ["-c:v","prores_ks","-profile:v",str(3 if quality >= 80 else 2 if quality >= 60 else 1),"-pix_fmt","yuv422p10le"], "prores_ks"
    if codec == "vp9": return ["-c:v","libvpx-vp9","-crf",str(q),"-b:v","0","-pix_fmt","yuv420p"], "libvpx-vp9"
    if codec == "png": return ["-c:v","png","-compression_level","4"], "png"
    hardware = {"h264":"h264_nvenc","hevc":"hevc_nvenc","av1":"av1_nvenc"}[codec]
    if os.getenv("REQUIRE_NVENC", "1") == "1":
        # Actual encoder availability is tested by FFmpeg; no silent codec change.
        return ["-c:v",hardware,"-preset","p6","-rc","vbr","-cq",str(q),"-b:v","0","-pix_fmt","yuv420p"], hardware
    software = {"h264":"libx264","hevc":"libx265","av1":"libaom-av1"}[codec]
    args = ["-c:v",software,"-crf",str(q),"-pix_fmt","yuv420p"]
    if codec == "av1": args += ["-cpu-used","6","-b:v","0"]
    else: args += ["-preset","fast"]
    return args, software

def run_ffmpeg(args, workdir, timeout):
    log = Path(workdir) / "ffmpeg.log"
    with log.open("wb") as stream:
        result = subprocess.run([FFMPEG, "-hide_banner", "-nostdin", "-y", "-filter_threads", "2"] + args,
            stdout=stream, stderr=stream, timeout=timeout)
    if result.returncode:
        # Full log stays on the worker; never expose paths or URLs to the panel.
        raise RuntimeError("Finishing failed. Check the worker's FFmpeg log and encoder support.")

def finish(source, workdir, payload):
    options = payload["options"]; comp = payload["comp"]
    output = validate_payload(payload)
    actual = probe(source)
    if actual["width"] != comp["width"] or actual["height"] != comp["height"] or abs(actual["duration"] - comp["duration"]) > max(.3, 2 / comp["fps"]) or abs(actual["fps"] - comp["fps"]) > .02:
        raise ValueError("Master does not match composition dimensions, duration or frame rate. Use a full-size, full-duration master template.")
    workdir = Path(workdir)
    extension, mime, _ = FORMATS[options["format"]]
    destination = workdir / ("finished." + extension)
    video_args, encoder = encoding(options["codec"], options["quality"])
    args = ["-protocol_whitelist","file,pipe","-i",str(source),"-map","0:v:0",
        "-vf",",".join(filters(options, output)), *video_args, "-threads","2"]
    timeout = int(os.getenv("JOB_TIMEOUT_SECONDS", "21600"))
    if extension == "zip":
        frames = workdir / "frames"; frames.mkdir()
        run_ffmpeg(args + ["-t",str(comp["duration"]), str(frames / "frame_%08d.png")], workdir, timeout)
        if actual["audio"]:
            run_ffmpeg(["-protocol_whitelist","file,pipe","-i",str(source),"-map","0:a:0","-vn","-c:a","pcm_s16le",str(frames / "audio.wav")], workdir, timeout)
        files = sorted(frames.iterdir())
        if not any(p.suffix == ".png" for p in files): raise RuntimeError("No frames were produced.")
        if sum(p.stat().st_size for p in files) > MAX_BYTES: raise ValueError("PNG sequence exceeds transfer limit.")
        (frames / "sequence.json").write_text(json.dumps({"fps":output["fps"],"width":output["width"],"height":output["height"]}), encoding="utf-8")
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
            for item in sorted(frames.iterdir()): archive.write(item, item.name)
    else:
        args += ["-map","0:a?","-c:a","libopus" if extension == "webm" else "pcm_s16le" if options["codec"] == "prores" else "aac"]
        if options["codec"] != "prores": args += ["-b:a","192k"]
        if extension in ("mp4","mov"): args += ["-movflags","+faststart"]
        if options["codec"] == "hevc": args += ["-tag:v","hvc1"]
        run_ffmpeg(args + ["-t",str(comp["duration"]), str(destination)], workdir, timeout)
    if not 0 < destination.stat().st_size <= MAX_BYTES: raise ValueError("Output exceeds the 4 GiB transfer limit.")
    return destination, mime, {"encoder":encoder, "output":output, "output_bytes":destination.stat().st_size}
