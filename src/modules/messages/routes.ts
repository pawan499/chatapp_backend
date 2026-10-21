import * as controller from "./controller.js";
import { Router } from "express";
import { z } from "zod";
import { auth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { rate } from "../../infrastructure/rateLimit.js";

import { reactions } from "./validation.js";
export const messageRoutes = Router();
messageRoutes.use(auth, rate("message-actions", 60));
messageRoutes.patch(
  "/:id",
  validate(z.object({ text: z.string().trim().min(1).max(10000) }).strict()),
  controller.updateById,
);
messageRoutes.delete("/:id", controller.deleteById);
messageRoutes.put(
  "/:id/reaction",
  validate(z.object({ emoji: z.enum(reactions) }).strict()),
  controller.setByIdReaction,
);
