# PocketEnvy v2 validation — 2026-09-21

Status: release candidate source. No production deployment, paid render, signed
ZXP or Windows After Effects session was performed in this environment.

## Completed checks

| Check | Result and scope |
|---|---|
| Platform tests | 13 passed: options/quotes, authenticated endpoints with injected database/storage/providers, idempotent reservation, settlement, dispatch uncertainty, cancellation, ownership, expiry and deletion retries |
| Render-node tests | 3 passed: persistent queue/restart, repeated submissions, queued cancellation, active process termination and next-job dispatch, storage destination restriction |
| Media/project tests | 6 passed: actual FFmpeg MP4/H.264, MOV/ProRes, WebM/VP9, PNG sequence plus WAV, dimensions/FPS, interpolation duration, master mismatch, ZIP traversal/symlink rejection, manifest/relink-script generation |
| CEP tests | 5 passed: single-call host loading, context reset, malformed/empty/error replies, JSON-free host serialization, Windows/Unix/network paths, real ZIP with sequence and proxy metadata |
| Browser acceptance | Passed at 520 and 380 pixels using Chromium; no page errors or horizontal overflow. Tested workflow/tier availability, full-project PNG selection, frozen settings during submission, submit/poll/download. AE, storage and API responses were simulated |
| Prisma | Client generated and v2 schema validated with pinned Prisma 6.12.0; initial SQL migration generated |
| Dependency audit | Platform production dependency audit reported 0 known vulnerabilities at time of check |
| Packaging | Separate extension and server archives; CEP ZIP runtime bundled; no credentials, backend node_modules, private certificate or signing executable included |

The 27 automated tests plus browser acceptance cover local behavior, not
production infrastructure. HTTP tests use a simulated transaction adapter,
not PostgreSQL. Media tests use CPU encoders, not NVENC. The AE relinking script
is validated as generated source and against archive fixtures, not executed
by After Effects. Preview account/credit values are sample data.

## Required Windows and deployment acceptance

1. Install the configured, signed ZXP on a clean supported Windows AE system.
   Confirm activation and reopening the host panel after a scripting-context reset.
2. Render a short comp through Cloud Finish at source and changed
   resolution/aspect/FPS. Verify audio, beginning/end frames, visual quality,
   color and output file integrity. Test every codec on each enabled GPU tier.
3. Render a collected project on the configured Windows node. Include nested
   comps, duplicate comp names, numbered footage, proxies, fonts and effects.
   Compare with the local AE output. Pre-render unsupported external dependencies.
4. Verify concurrent reservations, account ownership, repeated webhook delivery
   and exact-once settlement against the deployed PostgreSQL database.
5. Verify signed R2/S3 upload/download and deletion with real credentials.
   Close the panel during a cloud job; reconcile and resume after reopening.
6. Test queued and active cancellation, process restart and transfer/network
   failures. Confirm one reservation and the correct final charge/refund.
7. In an isolated test database, shorten a completed job's expiry, run cleanup,
   confirm downloads are withheld and both output and receipt are deleted.
   Monitor scheduled cleanup and retries; physical deletion depends on it running.
8. Verify the configured store's purchase/top-up mapping, license delivery,
   device limits and support reset. Set measured credit pricing, operational
   monitoring, abuse limits and isolated Windows execution before public sale.

Do not advertise validated GPU acceleration, universal project compatibility,
production readiness or an installable signed ZXP until the relevant live
checks pass. The included scripts make the signing and deployment work concrete,
but require the operator's endpoints, credentials and certificate.
