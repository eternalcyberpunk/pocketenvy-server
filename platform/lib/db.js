"use strict";
const { PrismaClient } = require("@prisma/client");
const globalState = globalThis;
const prisma = globalState.__pocketEnvyPrisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalState.__pocketEnvyPrisma = prisma;
module.exports = { prisma };
