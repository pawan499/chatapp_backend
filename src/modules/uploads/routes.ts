import { param } from "../../middleware/validate.js";
import * as service from "./service.js";
import * as controller from "./controller.js";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import { env } from "../../config/env.js";
import { auth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { rate } from "../../infrastructure/rateLimit.js";

import { allowed } from "./validation.js";

export const uploadRoutes = Router();
uploadRoutes.use(auth);
uploadRoutes.get("/:id", rate("media-metadata", 120), async (req, res) =>
  res.json(await service.metadata(req.auth, param(req))),
);
uploadRoutes.use(rate("uploads", 15, 900));
let inFlight = 0;
uploadRoutes.use((_req, res, next) => {
  if (inFlight >= 3) {
    res
      .status(503)
      .json({ code: "BUSY", message: "Uploads are busy. Please retry." });
    return;
  }
  inFlight++;
  res.once("close", () => inFlight--);
  next();
});
const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 0 },
}).single("file");
uploadRoutes.post("/", parser, controller.create);
uploadRoutes.post(
  "/init",
  validate(
    z
      .object({
        name: z.string().min(1).max(120),
        mime: z.enum(allowed as [string, ...string[]]),
        size: z.number().int().min(1).max(env.MAX_UPLOAD_BYTES),
      })
      .strict(),
  ),
  controller.createInit,
);
uploadRoutes.post("/:id/complete", controller.createByIdComplete);
export const mediaRoutes = Router();
mediaRoutes.get("/:id", rate("media", 300), controller.streamMedia);
