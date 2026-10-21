import { redis } from "./redis.js";
import { AppError } from "../utils/errors.js";
import { digest } from "../utils/crypto.js";
import type { RequestHandler } from "express";
const counters = new Map<string, { count: number; expires: number }>();
export async function consume(
  scope: string,
  key: string,
  limit: number,
  seconds: number,
) {
  const now = Date.now(),
    bucket = `rate:${scope}:${digest(key)}`;
  let count: number;
  if (redis) {
    if (!redis.isReady)
      throw new AppError(
        503,
        "RATE_STORE_UNAVAILABLE",
        "Please try again shortly.",
      );
    count = Number(
      await redis.eval(
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end;return n",
        { keys: [bucket], arguments: [String(seconds)] },
      ),
    );
  } else {
    if (counters.size > 10000) {
      for (const [k, v] of counters) if (v.expires < now) counters.delete(k);
      if (counters.size > 10000)
        throw new AppError(503, "BUSY", "Please retry shortly.");
    }
    let row = counters.get(bucket);
    if (!row || row.expires < now) {
      row = { count: 0, expires: now + seconds * 1000 };
      counters.set(bucket, row);
    }
    count = ++row.count;
  }
  if (count > limit)
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please try again later.",
    );
}
export function rate(
  scope: string,
  limit: number,
  seconds = 60,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await consume(
        scope,
        req.auth?.userId || req.ip || "unknown",
        limit,
        seconds,
      );
      next();
    } catch (e) {
      res.setHeader("Retry-After", seconds);
      next(e);
    }
  };
}
