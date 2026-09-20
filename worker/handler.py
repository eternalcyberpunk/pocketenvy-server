"""RunPod Serverless worker for PocketEnvy's cloud finishing stage."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import requests
import runpod

MAX_DOWNLOAD_BYTES = int(os.getenv("MAX_DOWNLOAD_BYTES", str(40 * 1024**3)))
JOB_TIMEOUT_SECONDS = int(os.getenv("JOB_TIMEOUT_SECONDS", "21600"))


def require_https_url(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a URL string")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError(f"{field} must use HTTPS")
    return value


def download(url: str, destination: Path) -> int:
    total = 0
    with requests.get(url, stream=True, timeout=(30, 300)) as response:
        response.raise_for_status()
        declared = int(response.headers.get("content-length", "0") or 0)
        if declared > MAX_DOWNLOAD_BYTES:
            raise ValueError("Input exceeds the worker download limit")
        with destination.open("wb") as output:
            for chunk in response.iter_content(chunk_size=8 * 1024**2):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise ValueError("Input exceeds the worker download limit")
                output.write(chunk)
    return total


def ffmpeg_has_encoder(name: str) -> bool:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, check=False
    )
    return name in result.stdout


def build_filters(options: dict) -> list[str]:
    filters: list[str] = []
    if int(options.get("upscale", 1)) == 2:
        filters.append("scale=trunc(iw*2/2)*2:trunc(ih*2/2)*2:flags=lanczos")
    if options.get("interpolate_fps") == 60:
        filters.append("minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir")
    if options.get("denoise") is True:
        filters.append("hqdn3d=1.5:1.5:6:6")
    if options.get("sharpen") is True:
        filters.append("unsharp=5:5:0.5:3:3:0.2")
    return filters


def encoder_args(codec: str, quality: int) -> tuple[list[str], str]:
    candidates = {
        "h264": ("h264_nvenc", ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(quality), "-b:v", "0"]),
        "hevc": ("hevc_nvenc", ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(quality), "-b:v", "0"]),
        "av1": ("av1_nvenc", ["-preset", "p6", "-rc", "vbr", "-cq", str(quality), "-b:v", "0"]),
    }
    encoder, args = candidates.get(codec, candidates["h264"])
    if ffmpeg_has_encoder(encoder):
        return ["-c:v", encoder, *args], encoder
    # Portable fallback. HEVC/AV1 requests fall back to H.264 rather than fail after a long upload.
    return ["-c:v", "libx264", "-preset", "slow", "-crf", str(quality)], "libx264"


def handler(job: dict) -> dict:
    payload = job.get("input") or {}
    input_url = require_https_url(payload.get("input_url"), "input_url")
    output_url = require_https_url(payload.get("output_url"), "output_url")
    options = payload.get("options") or {}
    codec = options.get("codec") if options.get("codec") in {"h264", "hevc", "av1"} else "h264"
    quality = max(12, min(32, int(options.get("quality", 20))))

    with tempfile.TemporaryDirectory(prefix="pocketenvy-") as temporary:
        workdir = Path(temporary)
        input_path = workdir / "master.input"
        output_path = workdir / "finished.mp4"
        input_bytes = download(input_url, input_path)

        video_args, encoder = encoder_args(codec, quality)
        command = ["ffmpeg", "-hide_banner", "-y", "-i", str(input_path)]
        filters = build_filters(options)
        if filters:
            command.extend(["-vf", ",".join(filters)])
        command.extend([
            *video_args,
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "320k",
            "-movflags", "+faststart",
            str(output_path),
        ])
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=JOB_TIMEOUT_SECONDS, check=False
        )
        if completed.returncode != 0:
            raise RuntimeError("FFmpeg failed: " + completed.stderr[-4000:])

        output_bytes = output_path.stat().st_size
        with output_path.open("rb") as source:
            uploaded = requests.put(
                output_url,
                data=source,
                headers={"Content-Type": "video/mp4", "Content-Length": str(output_bytes)},
                timeout=(30, 1800),
            )
            uploaded.raise_for_status()

        return {
            "ok": True,
            "encoder": encoder,
            "input_bytes": input_bytes,
            "output_bytes": output_bytes,
            "filters": filters,
        }


runpod.serverless.start({"handler": handler})

