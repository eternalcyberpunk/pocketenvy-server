# PocketEnvy API

Deploy this folder as the Vercel project root. Follow ../README.md for storage,
render workers, PostgreSQL migrations, activation and cron setup.

Copy .env.example to .env for local Prisma commands. Never commit its values.
Use npm ci, npm run db:migrate for a fresh database, then npm run check.
The API is exported from api/index.js and routes under /api/.

Database v2 is not compatible with an unchanged v1 deployment. The included
migration is an initial schema for a fresh database, not an automatic v1 data
upgrade. Back up and review a data-preserving migration before upgrading an
existing production database.
