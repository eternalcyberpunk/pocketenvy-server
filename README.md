# PocketEnvy Server

This repository deploys two services from one GitHub project:

- `platform/` — Vercel API, Prisma/PostgreSQL, activation, credits, and jobs.
- Root `Dockerfile` — RunPod Serverless video-finishing worker.

The After Effects panel never receives database, RunPod, or R2 credentials.

## 1. Publish this repository

Create an empty GitHub repository named `pocketenvy-server`, unzip this package,
and upload the **contents** of `pocketenvy-server/` to the repository root.

## 2. Create the Vercel API

1. In Vercel, select **Add New > Project** and import `pocketenvy-server`.
2. Set **Root Directory** to `platform`.
3. Leave the framework preset as **Other** and deploy once.
4. Open the project Marketplace/Storage area and add **Prisma Postgres**.
5. Confirm the integration created `DATABASE_URL`.
6. Locally run `scripts/new-secrets.ps1`; copy its five outputs into Vercel
   under **Settings > Environment Variables**.
7. Do not add the RunPod or R2 variables yet; we create those next.

The first deployment may be incomplete until all variables exist. That is
expected. Never put production secrets in `.env.example` or GitHub files.

## 3. Initialize PostgreSQL

After `DATABASE_URL` exists, install the Vercel CLI on Windows and run:

```powershell
npm install -g vercel
cd platform
vercel link
vercel env pull .env.local
npm install
npx prisma db push
```

Then redeploy from the Vercel dashboard and visit:

```text
https://YOUR-PROJECT.vercel.app/api/health
```

Expected response:

```json
{"ok":true,"service":"pocketenvy-api","version":"1.0.0"}
```

## 4. Create R2

In Cloudflare, open **Storage & databases > R2** and enable R2. Create a private
bucket named `pocketenvy-renders`, then create an R2 API token restricted to
Object Read & Write for only that bucket.

Add these Vercel variables:

```text
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=pocketenvy-renders
S3_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
S3_FORCE_PATH_STYLE=false
```

Keep the bucket private. PocketEnvy uses short-lived presigned URLs.

## 5. Create the RunPod endpoint

Connect RunPod to this GitHub repository and deploy it as a custom Serverless
worker using the root `Dockerfile`. Select a **Queue** endpoint, start with Flex
workers, zero active workers, one max worker, and a GPU that supports NVENC.

Create a RunPod API key and add these Vercel variables:

```text
RUNPOD_ENDPOINT_ID=YOUR_ENDPOINT_ID
RUNPOD_API_KEY=YOUR_API_KEY
```

Use a versioned Git commit or image digest for production rather than a mutable
`latest` image.

## 6. Finish Vercel configuration

Copy the remaining non-secret settings from `platform/.env.example`, redeploy,
and test `/api/health` again.

To reconcile jobs when customers close After Effects, add two GitHub Actions
repository secrets:

```text
POCKETENVY_API_BASE_URL=https://YOUR-PROJECT.vercel.app
POCKETENVY_CRON_SECRET=the same CRON_SECRET stored in Vercel
```

The scheduled workflow calls the authenticated reconciliation endpoint every
five minutes. GitHub schedules can be delayed, while panel polling settles jobs
immediately when the customer keeps PocketEnvy open.

## 7. Connect the extension

Run PocketEnvy's `scripts/configure-release.ps1` with the Vercel production URL,
then sign a new ZXP. Do not distribute a build containing placeholder URLs.

## Security rules

- Never commit `.env`, `.env.local`, API keys, database URLs, or certificates.
- Use separate random values for every PocketEnvy secret.
- Restrict the R2 token to one bucket and only Object Read & Write.
- Keep RunPod and R2 credentials only in Vercel.
- Rotate any secret accidentally pasted into GitHub, screenshots, or support logs.
