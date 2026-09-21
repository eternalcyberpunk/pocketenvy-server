# PocketEnvy server 2.0.0 — release candidate

This repository serves the PocketEnvy CEP panel. It provides activation, credits, upload authorization, per-render validation, managed compute tiers, job tracking, cancellation and storage cleanup. Configure the service before distributing a signed panel.

Cloud Finish sends a locally rendered AE master to the RunPod finishing worker. Full Project sends a collected project to a separate Windows After Effects render node, then applies the same finishing pipeline. The Linux RunPod worker does not run After Effects. Both workflows are implemented in source; real Windows AE, GPU, payment and storage acceptance tests remain required.

## Repository

| Path | Purpose |
|---|---|
| platform/ | Express API for Vercel, Prisma/PostgreSQL schema, tests |
| worker/media.py | Shared format, geometry, FPS and enhancement processing |
| worker/handler.py | RunPod job handler |
| worker/project_task.py | Windows project extraction, relinking, aerender and finishing |
| ae-farm-agent/ | Authenticated Windows queue with persistent local job states |
| Dockerfile | RunPod image built from the repository root |
| .github/workflows/ | Checks and scheduled reconciliation/cleanup |

No cloud credentials are included. Keep the private backend out of the ZXP. No existing GitHub repository or hosting service has been changed.

## 1. Create the GitHub repository

Create a private repository and upload the contents of this folder, including .github/. Keep platform, worker and ae-farm-agent at the root. Do not upload .env files, node_modules, certificates or render files. Use a separate GitHub repository from the extension if you want independent releases.

## 2. Configure private object storage

Create one private Cloudflare R2 or AWS S3 bucket. Give the API credentials only the object read/write/delete access it needs for inputs/ and outputs/. Keep public bucket access off.

For R2, use https://ACCOUNT_ID.r2.cloudflarestorage.com and region auto. For AWS S3, use the regional S3 endpoint and actual region. Set S3_FORCE_PATH_STYLE=true so the worker hostname allowlist matches the endpoint. If you deliberately use virtual-hosted URLs, allowlist the actual bucket hostname on both workers.

Uploads/downloads stream directly between the panel and signed storage URLs. The API receives metadata, not video bytes. Single-part transfers are capped at 4 GiB. No storage CORS rule is required by the panel's Node HTTPS transfers.

## 3. Deploy the API and fresh database

Use Node 22 for hosting/builds. Create a PostgreSQL database, then import the GitHub repository into Vercel with **Root Directory: platform** and framework **Other**. Copy platform/.env.example values into the hosting environment. Generate five distinct secrets of at least 32 random characters for JWT, license pepper, purchase webhook, cron and administration. scripts/new-secrets.ps1 can generate these on your machine.

For the first deployment, from platform/:

    npm ci
    # Copy .env.example to .env and fill DATABASE_URL, or pull the matching hosted environment:
    npx vercel env pull .env --environment=production
    npm run db:migrate
    npm run check
    npx prisma validate

The committed migration initializes an EMPTY database. Do not run it blindly against a v1 database; back up existing data and create/review a migration for that schema first. Do not use prisma db push to upgrade live customer data. Prisma commands load .env, not .env.local.

Deploy/redeploy after configuring the environment. Confirm /api/health returns version 2.0.0. /api/v1/capabilities shows which workflows and tiers are configured. A healthy API can still have no available render workers.

The API uses database transactions and row locks for reservations/settlement. Local tests inject a simulated database; PostgreSQL schema validation passed locally. GitHub checks also apply the baseline to a temporary PostgreSQL service when the workflow runs. Production database connectivity, transaction behavior and load still need deployment verification.

## 4. Enable Cloud Finish

Build the repository-root Dockerfile using RunPod's GitHub integration or your own container registry. Deploy the image as a queue-based RunPod Serverless endpoint. The image starts worker/handler.py and uses shared media.py.

Set worker environment:

    STORAGE_HOSTS=YOUR_STORAGE_ENDPOINT_HOSTNAME
    REQUIRE_NVENC=1
    MAX_TRANSFER_BYTES=4294967296
    JOB_TIMEOUT_SECONDS=21600

Choose GPU pools and an FFmpeg/driver combination that support H.264, HEVC AND AV1 NVENC before exposing a tier. ProRes and VP9 encode on CPU; filters, ZIP creation and transfer also consume CPU. Service tiers select operator-managed pools, with no fixed speed guarantee. Test every advertised codec on each enabled pool.

Set RUNPOD_API_KEY and one or more RUNPOD_ENDPOINT_ECONOMY / STANDARD / TURBO values on the API. Unconfigured tiers stay disabled in the panel. A single Standard endpoint is enough to begin testing. Hardware encoding failures fail the job; the worker does not silently substitute another codec.

The request uses a six-hour execution timeout and a 24-hour total deadline. Signed worker transfer URLs last up to 24 hours. A completion receipt is also written to storage so successful jobs can be settled after the provider's short status-result retention window. A lost dispatch response preserves the reservation until the receipt/deadline resolves it; retry the same idempotency key.

## 5. Enable Full Project

Follow ae-farm-agent/README.md to set up a dedicated Windows AE node and its HTTPS access. Set AE_FARM_API_KEY on the API and node, configure AE_FARM_BASE_URL for Standard, then set ENABLE_FULL_PROJECT=true after acceptance testing. Economy/Turbo can use separate AE_FARM_ECONOMY_URL / AE_FARM_TURBO_URL nodes.

The worker saves a prepared project after relinking footage by AE item ID, sets a full-duration queue item, runs aerender and finishes the resulting master. AE itself, fonts, third-party effects and their licensing are operator responsibilities. There is no blanket compatibility guarantee for arbitrary projects.

## 6. Connect purchases and activation

Use an authenticated Webhooks by Zapier POST action after a verified successful store purchase. Send to /api/v1/webhooks/zapier/purchase with:

    Authorization: Bearer YOUR_ZAPIER_WEBHOOK_SECRET
    Content-Type: application/json

Example JSON (map real order/customer/license fields):

    {
      "eventId": "unique-store-order-id",
      "email": "customer@example.com",
      "licenseKey": "license-key-delivered-by-your-store",
      "credits": 25,
      "productCode": "pocketenvy-25",
      "maxDevices": 2
    }

Use a unique order ID, normalize the purchase mapping, and set credits from your trusted SKU mapping. Replaying an event does not add credits twice. Keep the webhook secret private. The backend does not send email or generate a checkout page; the store delivers the same license key the customer activates in PocketEnvy.

A top-up should include licenseKey. Email-only top-ups are accepted only if exactly one active license matches. A purchase cannot transfer someone else's license or reactivate a revoked one. Credits use 1000 integer units per displayed credit. Default prices are examples; measure worker/storage costs and set a commercially appropriate margin.

Activation returns a device-bound session. Device reset is POST /api/v1/admin/devices/reset with the ADMIN_SECRET bearer token and JSON {"licenseKey":"..."}. Reset invalidates the affected active device sessions. Session signing/pepper and administrative secrets fail closed if missing or too short. Keep license pepper stable; changing it requires a planned license migration.

## 7. Run reconciliation and retention cleanup

In GitHub repository Actions secrets, set POCKETENVY_API_BASE_URL and POCKETENVY_CRON_SECRET. Enable .github/workflows/reconcile.yml and run it manually once. It requests GET /api/cron/reconcile with the cron bearer secret, then runs on an every-five-minutes schedule.

The task settles unfinished jobs, deletes finished job inputs, removes expired outputs/receipts, and removes unused uploads older than one day. It works in bounded batches and retries deletion failures. Job/license/credit metadata remains for account history. Persistent Windows scratch is deleted when its task finishes; local state/result metadata remains for recovery.

Retention starts when completion is recorded, not at submission. Downloads stop being issued after the chosen period. Physical deletion happens on the next successful cleanup pass. GitHub schedules can be delayed or disabled, so monitor cleanup and use a reliable scheduler at scale. Storage lifecycle rules, if added as a backstop, must not delete valid retained outputs early.

## Tests and rollout

Run locally:

    npm --prefix platform ci
    npm --prefix platform run check
    npm --prefix ae-farm-agent ci
    npm --prefix ae-farm-agent run check
    python -m pip install -r ae-farm-agent/requirements.txt
    python -m unittest discover -s tests -v

FFmpeg/ffprobe must be on PATH for media tests. Tests deliberately select software encoders to validate finishing without a GPU; production REQUIRE_NVENC defaults to 1.

Before charging customers, verify both workflows in AE, paid activation/top-ups, all codecs per enabled tier, real S3/R2 PUT/GET/DELETE, restart/cancel/refund, simultaneous reservations against PostgreSQL, duplicate webhook delivery, offline-panel reconciliation and expiry cleanup. Set abuse/rate limits and monitoring at the hosting edge. This source is a release candidate until those live checks pass.

Operator references: [Adobe automated rendering](https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html), [RunPod requests and policies](https://docs.runpod.io/serverless/endpoints/send-requests), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html).
