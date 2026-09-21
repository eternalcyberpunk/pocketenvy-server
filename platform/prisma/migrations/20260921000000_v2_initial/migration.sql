-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('RESERVED', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "RenderWorkflow" AS ENUM ('CLOUD_FINISH', 'FULL_PROJECT');

-- CreateEnum
CREATE TYPE "ComputeTier" AS ENUM ('ECONOMY', 'STANDARD', 'TURBO');

-- CreateEnum
CREATE TYPE "RenderProvider" AS ENUM ('RUNPOD', 'AE_FARM');

-- CreateEnum
CREATE TYPE "CreditKind" AS ENUM ('PURCHASE', 'ADMIN_GRANT', 'JOB_RESERVATION', 'JOB_SETTLEMENT', 'JOB_REFUND');

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxDevices" INTEGER NOT NULL DEFAULT 2,
    "creditBalanceUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "providerJobId" TEXT,
    "provider" "RenderProvider" NOT NULL,
    "providerLocation" TEXT NOT NULL,
    "workflow" "RenderWorkflow" NOT NULL,
    "computeTier" "ComputeTier" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'RESERVED',
    "inputKey" TEXT NOT NULL,
    "outputKey" TEXT NOT NULL,
    "outputFilename" TEXT NOT NULL,
    "reservedCreditUnits" INTEGER NOT NULL,
    "settledCreditUnits" INTEGER,
    "comp" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "receiptKey" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "executionTimeMs" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "inputPurgedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "key" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "jobId" TEXT,
    "units" INTEGER NOT NULL,
    "kind" "CreditKind" NOT NULL,
    "externalRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "License_keyHash_key" ON "License"("keyHash");

-- CreateIndex
CREATE INDEX "License_email_idx" ON "License"("email");

-- CreateIndex
CREATE INDEX "Device_licenseId_active_idx" ON "Device"("licenseId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Device_licenseId_deviceHash_key" ON "Device"("licenseId", "deviceHash");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_providerJobId_key" ON "RenderJob"("providerJobId");

-- CreateIndex
CREATE INDEX "RenderJob_licenseId_status_idx" ON "RenderJob"("licenseId", "status");

-- CreateIndex
CREATE INDEX "RenderJob_status_settledAt_idx" ON "RenderJob"("status", "settledAt");

-- CreateIndex
CREATE INDEX "RenderJob_expiresAt_purgedAt_idx" ON "RenderJob"("expiresAt", "purgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_licenseId_clientRequestId_key" ON "RenderJob"("licenseId", "clientRequestId");

-- CreateIndex
CREATE INDEX "Upload_licenseId_usedAt_idx" ON "Upload"("licenseId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_externalRef_key" ON "CreditLedger"("externalRef");

-- CreateIndex
CREATE INDEX "CreditLedger_licenseId_createdAt_idx" ON "CreditLedger"("licenseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_externalId_key" ON "WebhookEvent"("source", "externalId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

