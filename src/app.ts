import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env, origins } from "./config/env.js";
import { logger } from "./infrastructure/logger.js";
import { redis } from "./infrastructure/redis.js";
import { registry, requests, duration } from "./infrastructure/metrics.js";
import { AppError } from "./utils/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { conversationRoutes } from "./modules/conversations/routes.js";
import { messageRoutes } from "./modules/messages/routes.js";
import { uploadRoutes, mediaRoutes } from "./modules/uploads/routes.js";
import { rate } from "./infrastructure/rateLimit.js";
import { readFile } from "node:fs/promises";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY_HOPS) app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.use((req, res, next) => {
    const provided = req.headers["x-request-id"];
    req.requestId =
      typeof provided === "string" && z.uuid().safeParse(provided).success
        ? provided
        : randomUUID();
    res.setHeader("X-Request-ID", req.requestId);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { requestId: string }).requestId,
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          path: req.url?.split("?")[0],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res) => (res.statusCode >= 500 ? "error" : "info"),
      autoLogging: env.NODE_ENV !== "test",
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
      credentials: false,
    }),
  );
  app.use((req, res, next) => {
    if (app.locals.draining && req.path !== "/health") {
      res.status(503).json({
        code: "SHUTTING_DOWN",
        message: "Server is restarting. Please retry.",
      });
      return;
    }
    if (req.headers.origin && !origins.includes(req.headers.origin)) {
      res
        .status(403)
        .json({ code: "ORIGIN_DENIED", message: "Origin is not allowed." });
      return;
    }
    if (
      env.NODE_ENV === "production" &&
      !req.secure &&
      !["/health", "/ready"].includes(req.path)
    ) {
      res
        .status(426)
        .json({ code: "TLS_REQUIRED", message: "HTTPS is required." });
      return;
    }
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const route = req.route?.path || "unmatched";
      requests.inc({ method: req.method, route, status: res.statusCode });
      duration.observe(
        { method: req.method, route },
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const httpRate = rate("http", 600);
  app.use((req, res, next) =>
    ["/health", "/ready", "/metrics"].includes(req.path)
      ? next()
      : httpRate(req, res, next),
  );
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    const database = mongoose.connection.readyState === 1;
    let cache = !redis;
    try {
      if (redis) cache = redis.isReady && (await redis.ping()) === "PONG";
      if (database) await mongoose.connection.db!.admin().ping();
      res
        .status(database && cache ? 200 : 503)
        .json({ status: database && cache ? "ready" : "unavailable" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get("/metrics", async (req, res) => {
    if (
      env.NODE_ENV === "production" &&
      req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`
    ) {
      res.sendStatus(401);
      return;
    }
    res.type(registry.contentType).send(await registry.metrics());
  });
  app.get("/api/v1/capabilities", (_req, res) =>
    res.json({
      otp: env.EMAIL_VERIFICATION,
      attachments: true,
      voice: true,
      push: !!env.FCM_PROJECT_ID,
    }),
  );
  app.get("/api/v1/openapi.json", async (_req, res) =>
    res
      .type("application/json")
      .send(
        await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
      ),
  );
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/conversations", conversationRoutes);
  app.use("/api/v1/messages", messageRoutes);
  app.use("/api/v1/uploads", uploadRoutes);
  app.use("/api/v1/media", mediaRoutes);
  app.use("/api/v1", userRoutes);
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Endpoint not found.")),
  );
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Check your request fields.",
          issues: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
          requestId: req.requestId,
        });
        return;
      }
      const code = (error as { code?: string })?.code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          code: "UPLOAD_SIZE",
          message: "File exceeds the upload limit.",
          requestId: req.requestId,
        });
        return;
      }
      if (code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({
          code: "INVALID_FILE",
          message: "Upload one file using the file field.",
          requestId: req.requestId,
        });
        return;
      }
      if (
        error instanceof SyntaxError ||
        (error as { type?: string })?.type === "entity.parse.failed"
      ) {
        res.status(400).json({
          code: "INVALID_JSON",
          message: "Request body must be valid JSON.",
          requestId: req.requestId,
        });
        return;
      }
      if ((error as { type?: string })?.type === "entity.too.large") {
        res.status(413).json({
          code: "BODY_TOO_LARGE",
          message: "Request body is too large.",
          requestId: req.requestId,
        });
        return;
      }
      if (error instanceof AppError) {
        res.status(error.status).json({
          code: error.code,
          message: error.message,
          requestId: req.requestId,
        });
        return;
      }
      logger.error(
        {
          requestId: req.requestId,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "Request failed",
      );
      res.status(500).json({
        code: "INTERNAL_ERROR",
        message: "Unable to complete the request.",
        requestId: req.requestId,
      });
    },
  );
  return app;
}
