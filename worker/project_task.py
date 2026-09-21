"""Run one collected project on a dedicated Windows render node."""
from __future__ import annotations
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath
from media import download, upload, finish, receipt, validate_payload

def contained(directory, relative):
    text = str(relative).replace("\\", "/")
    path = PurePosixPath(text)
    if not text or text in (".","/") or path.is_absolute() or any(part in ("..","") for part in path.parts) or ":" in text or "\x00" in text:
        raise ValueError("Unsafe package path.")
    if any(part.rstrip(" .") != part or part.split(".")[0].upper() in ({"CON","PRN","AUX","NUL"} | {"COM"+str(n) for n in range(1,10)} | {"LPT"+str(n) for n in range(1,10)}) for part in path.parts):
        raise ValueError("Unsupported Windows file name.")
    target = (directory / str(path)).resolve()
    if not target.is_relative_to(directory.resolve()): raise ValueError("Package escaped job directory.")
    return target

def extract_package(source, directory):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 100000 or sum(e.file_size for e in entries) > int(os.getenv("MAX_UNPACK_BYTES", str(20*1024**3))):
            raise ValueError("Collected project exceeds unpacking limits.")
        seen = set()
        for entry in entries:
            target = contained(directory,entry.filename)
            canonical = str(target).lower()
            if canonical in seen: raise ValueError("Duplicate package path.")
            seen.add(canonical)
            if stat.S_ISLNK(entry.external_attr >> 16): raise ValueError("Links are not allowed in project packages.")
            if entry.is_dir(): target.mkdir(parents=True,exist_ok=True); continue
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(entry) as src, target.open("xb") as dst: shutil.copyfileobj(src,dst,1024**2)
    manifest_path = directory / "pocketenvy-manifest.json"
    if not manifest_path.is_file(): raise ValueError("Project manifest is missing.")
    if manifest_path.stat().st_size > 4*1024**2: raise ValueError("Project manifest is too large.")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if manifest.get("version") != 2: raise ValueError("Unsupported project package version.")
    project = contained(directory, manifest["project"])
    if project.suffix.lower() not in (".aep",".aepx") or not project.is_file(): raise ValueError("Project file is missing.")
    for asset in manifest["assets"]:
        if not isinstance(asset.get("itemId"),int) or asset["itemId"] <= 0: raise ValueError("Invalid footage identity.")
        if asset.get("role") not in ("source","proxy"): raise ValueError("Invalid footage role.")
        if not contained(directory,asset["packagedPath"]).is_file(): raise ValueError("Collected footage is missing.")
    return manifest

def js(value): return json.dumps(value,ensure_ascii=True)

def relinker(directory, manifest, payload):
    """Generate only trusted script code; all package values become JSON literals."""
    project = contained(directory,manifest["project"])
    assets = [{**a, "localPath":str(contained(directory,a["packagedPath"]))} for a in manifest["assets"]]
    target = directory / "prepared.aep"
    ready = directory / "prepared.status"
    comp_id = payload["comp"].get("id")
    code = """
(function(){
  var marker=new File(MARKER), result="OK";
  app.beginSuppressDialogs();
  try{
    app.open(new File(PROJECT));
    var comp=null, wanted=COMP;
    for(var i=1;i<=app.project.numItems;i++){
      var candidate=app.project.item(i);
      if(candidate instanceof CompItem && ((wanted.id && candidate.id===wanted.id)||(!wanted.id && candidate.name===wanted.name))) {
        if(comp) throw new Error("Composition name is ambiguous."); comp=candidate;
      }
    }
    if(!comp) throw new Error("Requested composition is missing.");
    if(comp.name!==wanted.name||comp.width!==wanted.width||comp.height!==wanted.height||Math.abs(comp.duration-wanted.duration)>.01||Math.abs(comp.frameRate-wanted.fps)>.01)
      throw new Error("Composition changed after the estimate.");
    var assets=ASSETS;
    for(var a=0;a<assets.length;a++){
      var entry=assets[a], item=null;
      for(var n=1;n<=app.project.numItems;n++){if(app.project.item(n).id===entry.itemId){item=app.project.item(n);break;}}
      if(!item) throw new Error("Footage item is missing.");
      var f=new File(entry.localPath);
      if(!f.exists) throw new Error("Collected media is missing.");
      if(entry.role==="proxy"){
        if(entry.sequence) item.setProxyWithSequence(f,false); else item.setProxy(f);
        item.useProxy=entry.useProxy;
      } else {
        if(entry.sequence) item.replaceWithSequence(f,false); else item.replace(f);
      }
    }
    var queue=app.project.renderQueue;
    while(queue.numItems) queue.item(1).remove();
    var rq=queue.items.add(comp);
    rq.applyTemplate(RENDER_TEMPLATE);
    rq.timeSpanStart=0; rq.timeSpanDuration=comp.duration; rq.skipFrames=0;
    rq.outputModule(1).applyTemplate(OUTPUT_TEMPLATE);
    rq.outputModule(1).file=new File(MASTER);
    app.project.save(new File(TARGET));
    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  }catch(e){result="ERROR: "+e.toString();}
  app.endSuppressDialogs(false);
  marker.encoding="UTF-8"; if(marker.open("w")){marker.write(result);marker.close();}
})();
"""
    replacements = {"MARKER":str(ready),"PROJECT":str(project),"COMP":payload["comp"],"ASSETS":assets,
        "RENDER_TEMPLATE":os.getenv("AE_RENDER_TEMPLATE","Best Settings"),
        "OUTPUT_TEMPLATE":os.getenv("AE_MASTER_TEMPLATE","Lossless"),
        "MASTER":str(directory/"master.avi"),"TARGET":str(target)}
    # Single token pass prevents a customer name from being treated as a template token.
    code = re.sub(r"\b("+"|".join(replacements)+r")\b",lambda m:js(replacements[m.group()]),code)
    script = directory / "prepare.jsx"; script.write_text(code,"utf-8")
    return script, ready, target

def kill_tree(process):
    if process.poll() is not None: return
    if os.name == "nt":
        subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],capture_output=True)
    else: process.kill()

def prepare(directory, manifest, payload):
    script, ready, target = relinker(directory, manifest, payload)
    with (directory/"afterfx.log").open("wb") as log:
        # -m isolates this launch from another After Effects instance.
        process = subprocess.Popen([os.environ["AFTERFX_PATH"],"-m","-r",str(script)],stdout=log,stderr=log)
        try:
            deadline = time.monotonic()+int(os.getenv("AE_PREPARE_TIMEOUT_SECONDS","300"))
            while not ready.exists():
                if time.monotonic()>deadline: raise RuntimeError("Project preparation timed out.")
                time.sleep(.5)
            result = ready.read_text("utf-8-sig")
            if result != "OK": raise ValueError(result[:1000])
            if not target.is_file(): raise ValueError("Prepared project was not saved.")
        finally: kill_tree(process)
    return target

def execute(payload, directory):
    validate_payload(payload)
    source = directory / "input.zip"; download(payload["input_url"],source)
    package_dir = directory / "project"; package_dir.mkdir()
    manifest = extract_package(source,package_dir)
    prepared = prepare(package_dir,manifest,payload)
    with (directory/"aerender.log").open("wb") as log:
        subprocess.run([os.environ["AERENDER_PATH"],"-project",str(prepared),"-rqindex","1"],
            stdout=log,stderr=log,check=True,timeout=int(os.getenv("JOB_TIMEOUT_SECONDS","21600")))
    destination, mime, details = finish(package_dir/"master.avi",directory,payload)
    upload(payload["output_url"],destination,mime)
    return details

def main():
    payload_path = Path(sys.argv[1]).resolve()
    payload = json.loads(payload_path.read_text("utf-8"))
    directory = payload_path.parent / "work"; directory.mkdir()
    started = time.monotonic()
    result = {"jobId":payload["job_id"],"status":"FAILED"}
    try: result.update(status="COMPLETED",output=execute(payload,directory))
    except Exception as error:
        result["error"] = str(error) if isinstance(error,ValueError) else "Full-project rendering failed. Contact support with the job ID."
    result["executionTimeMs"] = round((time.monotonic()-started)*1000)
    # Local result survives restarts; receipt survives the worker lifecycle.
    (payload_path.parent/"result.json").write_text(json.dumps(result),"utf-8")
    try: receipt(payload["receipt_url"],result)
    except Exception: pass
    finally: shutil.rmtree(directory,ignore_errors=True)
    return 0 if result["status"]=="COMPLETED" else 1

if __name__ == "__main__": sys.exit(main())
