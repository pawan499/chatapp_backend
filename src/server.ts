import { verifyIndexes } from "./database/verifyIndexes.js";
import { createServer } from "node:http";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { connectDatabase } from "./database/connection.js";
import { connectRedis, redis } from "./infrastructure/redis.js";
import { logger } from "./infrastructure/logger.js";
import { createApp } from "./app.js";
import { attachSockets } from "./sockets/server.js";
import { startJobs } from "./infrastructure/jobs.js";
import { AppError } from "./utils/errors.js";
let startupStage = "database connection";
try {
  await connectDatabase();
  startupStage = "database indexes";
  await verifyIndexes();
  startupStage = "Redis connection";
  await connectRedis();
  startupStage = "HTTP application";
  const app = createApp();
  const server = createServer(app);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  startupStage = "socket initialization";
  const sockets = await attachSockets(server);
  const stopJobs = startJobs(sockets.io);
  server.listen(env.PORT, "0.0.0.0", () =>
    logger.info({ port: env.PORT }, "Luma API listening"),
  );
  let closing = false;
  const close = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    app.locals.draining = true;
    sockets.beginShutdown();
    const httpDrained = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    server.closeIdleConnections();
    const timeout = setTimeout(() => process.exit(1), 30000);
    timeout.unref();
    await stopJobs();
    await sockets.close();
    await httpDrained;
    await mongoose.disconnect();
    await redis?.quit();
    clearTimeout(timeout);
    await new Promise<void>((resolve) => logger.flush(() => resolve()));
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => close());
  process.on("SIGINT", () => close());
  process.on("unhandledRejection", () => {
    logger.fatal(
      { event: "unhandled_rejection" },
      "Stopping after unexpected failure",
    );
    close(1);
  });
} catch (e) {
  logger.fatal(
    {
      errorType: e instanceof Error ? e.name : "unknown",
      startupStage,
    },
    e instanceof AppError
      ? `Startup failed: ${e.message}`
      : startupStage === "database connection"
        ? "Startup failed: cannot connect to MongoDB. Check MONGODB_URI and start a replica set with npm run dev:db (or Docker Compose)."
        : `Startup failed during ${startupStage}; check dependency readiness`,
  );
  process.exit(1);
}
