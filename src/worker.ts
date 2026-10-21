import { verifyIndexes } from "./database/verifyIndexes.js";
import mongoose from "mongoose";
import { connectDatabase } from "./database/connection.js";
import { connectRedis, redis } from "./infrastructure/redis.js";
import { startJobs } from "./infrastructure/jobs.js";
await connectDatabase();
await verifyIndexes();
await connectRedis();
const stop = startJobs();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await stop();
  await mongoose.disconnect();
  await redis?.quit();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
