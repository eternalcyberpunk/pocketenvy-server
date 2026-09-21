"""RunPod entry point. The same finishing engine is used on Windows."""
import tempfile
import time
from pathlib import Path
from media import download, upload, finish, receipt, validate_payload

def handler(job):
    payload = job["input"]
    started = time.monotonic()
    result = {"jobId":payload["job_id"], "status":"FAILED"}
    try:
        validate_payload(payload)
        with tempfile.TemporaryDirectory(prefix="pocketenvy-") as directory:
            source = Path(directory) / "master.input"
            download(payload["input_url"], source)
            output, content_type, details = finish(source, directory, payload)
            upload(payload["output_url"], output, content_type)
            result.update(status="COMPLETED", output=details)
    except Exception as error:
        result["error"] = str(error) if isinstance(error, ValueError) else "Cloud finishing failed. Please contact support with the job ID."
    result["executionTimeMs"] = round((time.monotonic() - started) * 1000)
    receipt(payload["receipt_url"], result)
    if result["status"] != "COMPLETED": raise RuntimeError(result["error"])
    return result

if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler":handler})
