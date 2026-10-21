import { z } from "zod";
import { id } from "../../utils/pagination.js";
export const sendSchema = z
  .object({
    conversationId: id,
    clientId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    text: z.string().trim().max(10000).default(""),
    attachmentIds: z.array(id).max(5).default([]),
    replyToId: id.optional(),
  })
  .strict()
  .refine((v) => v.text.length > 0 || v.attachmentIds.length > 0, {
    message: "Add text or an attachment.",
  })
  .refine((v) => new Set(v.attachmentIds).size === v.attachmentIds.length, {
    message: "Duplicate attachment IDs.",
  });
export const reactions = ["❤️", "👍", "😂", "🎉", "🙏"] as const;
