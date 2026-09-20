# PocketEnvy Customer Platform

This private service keeps RunPod, storage, billing, and database credentials
off customer computers.

## Deploy to Vercel

1. Create a Vercel project whose root directory is `platform`.
2. Add Vercel Postgres (or another PostgreSQL database) and set `DATABASE_URL`.
3. Copy every variable from `.env.example` into the Vercel project.
4. Generate every secret independently with at least 32 random bytes.
5. From this directory, initialize and deploy:

   ```powershell
   npm install
   npx prisma generate
   npx prisma db push
   npx vercel --prod
   ```

6. Confirm `https://YOUR-PROJECT.vercel.app/api/health` returns `ok: true`.

For production schema changes, commit Prisma migrations and use
`npm run db:migrate`.

## Configure RunPod

Build `worker/Dockerfile`, push the image, and create a RunPod Serverless
endpoint from it. Set its endpoint ID and API key in Vercel. The API creates
short-lived storage URLs, so the worker receives no permanent storage keys.

The worker image needs an NVIDIA runtime for NVENC. The H.264 CPU fallback is
for testing, not profitable production rendering.

## Connect Payhip through Zapier

For each paid product, POST to:

```text
https://YOUR-PROJECT.vercel.app/api/v1/webhooks/zapier/purchase
```

Add `Authorization: Bearer YOUR_ZAPIER_WEBHOOK_SECRET` and send:

```json
{
  "eventId": "PAYHIP_ORDER_ID",
  "email": "CUSTOMER_EMAIL",
  "licenseKey": "YOUR_GENERATED_LICENSE_KEY",
  "credits": 25,
  "productCode": "pocketenvy-starter",
  "maxDevices": 2
}
```

The first purchase must include a unique license key. Credit top-ups can omit
it and will use the oldest active license for that email. Zapier retries are
safe because `eventId` is idempotent.

| Product | Credits | Purpose |
| --- | ---: | --- |
| PocketEnvy Starter | 25 | License and first credits |
| 25-credit pack | 25 | Small top-up |
| 100-credit pack | 100 | Volume top-up |

One credit is 1,000 atomic units. Defaults price a one-minute 1080p H.264 finish
at approximately one credit, reserve a 25% safety margin, and return unused
units. Calibrate `.env` against real RunPod jobs before selling credits.

## Reset customer devices

```powershell
$Headers = @{ Authorization = "Bearer $env:ADMIN_SECRET" }
$Body = @{ email = "customer@example.com" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://YOUR-PROJECT.vercel.app/api/v1/admin/devices/reset" -Headers $Headers -ContentType "application/json" -Body $Body
```

## Production checks

- Use a private R2 bucket with lifecycle deletion.
- Set Vercel spending and RunPod concurrency limits.
- Test purchases, duplicate webhooks, activation, low balance, completion,
  failure refunds, cancellation, device limits, and device resets.
- Never place secrets or `certificate.p12` in the customer ZXP.
