import * as controller from "./controller.js";
import { Router } from "express";
import { z } from "zod";

import { auth } from "../../middleware/auth.js";
import { param, validate } from "../../middleware/validate.js";
import { id } from "../../utils/pagination.js";
import { rate } from "../../infrastructure/rateLimit.js";

import { receipt } from "../messages/service.js";

export const conversationRoutes = Router();
conversationRoutes.use(auth);
conversationRoutes.post(
  "/",
  rate("conversation-create", 20, 3600),
  validate(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("direct"), userId: id }).strict(),
      z
        .object({
          kind: z.literal("group"),
          name: z.string().trim().min(2).max(80),
          memberIds: z.array(id).min(1).max(255),
        })
        .strict(),
    ]),
  ),
  controller.create,
);
conversationRoutes.get("/", rate("conversation-search", 60), controller.list);
conversationRoutes.get("/:id", controller.getById);
conversationRoutes.patch(
  "/:id",
  validate(
    z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(500).optional(),
        avatarId: id.optional(),
        pinned: z.boolean().optional(),
        muted: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
  ),
  controller.updateById,
);
conversationRoutes.post(
  "/:id/members",
  rate("membership", 30),
  validate(
    z
      .object({
        userId: id,
        action: z.enum(["add", "remove", "promote", "demote", "leave"]),
      })
      .strict(),
  ),
  controller.createByIdMembers,
);
conversationRoutes.get(
  "/:id/messages",
  rate("history", 60),
  controller.getByIdMessages,
);
conversationRoutes.post(
  "/:id/messages",
  rate("messages", 60),
  controller.createByIdMessages,
);
for (const kind of ["read", "delivered"] as const)
  conversationRoutes.post(
    `/:id/${kind}`,
    rate("receipts", 120),
    validate(z.object({ messageId: id }).strict()),
    async (req, res) => {
      await receipt(req.auth, param(req), req.body.messageId, kind);
      res.sendStatus(204);
    },
  );
conversationRoutes.get(
  "/:id/shared",
  rate("shared", 30),
  controller.getByIdShared,
);
