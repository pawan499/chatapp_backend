import { createClient } from "redis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
export const redis = env.REDIS_URL
  ? createClient({ url: env.REDIS_URL })
  : undefined;
redis?.on("error", () =>
  logger.error({ event: "redis_unavailable" }, "Redis connection failed"),
);
export async function connectRedis() {
  if (redis) await redis.connect();
}
