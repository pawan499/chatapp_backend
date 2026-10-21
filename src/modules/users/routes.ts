import * as controller from "./controller.js";
import { Router } from "express";
import { z } from "zod";

import { auth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { rate } from "../../infrastructure/rateLimit.js";
import { id } from "../../utils/pagination.js";

export const userRoutes = Router();
userRoutes.use(auth);
userRoutes.get("/me", controller.getMe);
userRoutes.patch(
  "/me",
  validate(
    z
      .object({
        name: z.string().trim().min(2).max(80),
        bio: z.string().trim().max(160).optional(),
        avatarId: id.optional(),
      })
      .strict(),
  ),
  controller.updateMe,
);
userRoutes.delete(
  "/me",
  rate("delete-account", 3, 3600),
  validate(
    z
      .object({
        confirmation: z.literal("DELETE"),
        password: z.string().min(1).max(128),
      })
      .strict(),
  ),
  controller.deleteMe,
);
userRoutes.get("/me/preferences", controller.getMePreferences);
userRoutes.patch(
  "/me/preferences",
  validate(
    z
      .object({
        notifications: z.boolean().optional(),
        previews: z.boolean().optional(),
        readReceipts: z.boolean().optional(),
        lastSeen: z.boolean().optional(),
      })
      .strict()
      .refine((x) => Object.keys(x).length > 0),
  ),
  controller.updateMePreferences,
);
userRoutes.get("/users/:id", controller.getUsersById);
userRoutes.get("/contacts", rate("search", 30), controller.getContacts);
userRoutes.get("/me/blocked", controller.getMeBlocked);
userRoutes.put(
  "/me/blocked/:id",
  validate(z.object({ blocked: z.boolean() }).strict()),
  controller.setMeBlockedById,
);
userRoutes.post(
  "/reports",
  rate("reports", 5, 3600),
  validate(
    z
      .object({ userId: id, reason: z.string().trim().min(10).max(1000) })
      .strict(),
  ),
  controller.createReports,
);
userRoutes.put(
  "/me/devices",
  rate("devices", 10),
  validate(
    z
      .object({
        token: z.string().min(20).max(4096),
        platform: z.enum(["android", "ios"]),
      })
      .strict(),
  ),
  controller.setMeDevices,
);
userRoutes.get("/me/devices", controller.getMeDevices);
userRoutes.delete("/me/devices/:id", controller.deleteMeDevicesById);
