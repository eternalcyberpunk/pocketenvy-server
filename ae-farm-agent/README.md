# PocketEnvy Windows render node

Run this on a dedicated Windows machine/VM with a compatible After Effects
installation. It accepts authenticated jobs from the PocketEnvy API, keeps a
persistent queue, prepares a relinked project, runs aerender and applies the
shared Python finishing pipeline. It is not part of the customer's ZXP.

1. Install Node 22, Python 3.12, After Effects, required effects/fonts, and a
   Windows FFmpeg build with ffprobe and the advertised encoders. Configure
   AE's scripting/file/network preference and render templates. A compatible
   NVIDIA GPU/driver is required when REQUIRE_NVENC=1.
2. Keep ae-farm-agent/ and worker/ as sibling folders. From ae-farm-agent/, run
   npm ci and python -m pip install -r requirements.txt.
3. Copy .env.example to .env; set the actual executable paths, storage
   hostname, work directory and a strong AE_FARM_API_KEY. Confirm the matching
   AE_MASTER_TEMPLATE writes a single full-resolution master. Default is
   Lossless to master.avi and Best Settings; localized installations may
   require different template names. Configure matching templates explicitly.
4. Run npm start from this folder. It loads .env and binds to 127.0.0.1:8787.
   Run it under a supervised service with a dedicated account and persistent
   WORK_ROOT. Publish only an authenticated HTTPS reverse proxy/tunnel to the
   API; do not expose the raw HTTP listener publicly. Allow the proxy enough
   time for the short job-submission/status calls; rendering is asynchronous.
5. On the API, configure the same key, the node's HTTPS base URL, and
   ENABLE_FULL_PROJECT=true only after a successful end-to-end render.

Set REQUIRE_NVENC=0 only when deliberately using software H.264/HEVC/AV1.
This preserves the chosen codec but changes performance. The example assumes
GPU encoding. ProRes 422 and VP9 are CPU encoders in either mode.

The node uses one task at a time. Job state persists in WORK_ROOT/job-id.
Queued cancellation removes its payload; active cancellation kills the task
process tree. After a restart, queued jobs resume. Interrupted active jobs with
no recorded result become failed and are refunded by the API. Completed local
results and cloud receipts allow reconciliation. Keep WORK_ROOT on durable
storage and monitor disk capacity.

Submitted AE projects are untrusted executable content: expressions and
third-party effects can access a worker's environment/files/network. ZIP path
validation is not a sandbox. Use isolated render VMs/accounts, no personal
files, restricted outbound access and network policy, narrow storage access,
and secrets scoped to the node. Do not share a desktop or broad cloud
credentials with customer renders. Production tenant isolation and hardening
require validation before enabling this workflow for public customers.

Collection handles file footage, matching numbered sequences and proxies.
Fonts/effects and external dependencies hidden inside expressions, Dynamic
Link or effect settings are not installed/collected automatically. Layer-specific
PSD/AI imports and unusual relinking cases need acceptance testing or a local
pre-render. The render node's AE version and color settings must match the
project; matching dimensions/FPS is not a proof of pixel parity.

Run npm run check for queue/restart/cancellation tests. Those checks use a
temporary stand-in process, not an actual After Effects installation.
