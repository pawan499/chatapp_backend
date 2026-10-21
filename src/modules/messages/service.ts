import {
  Message,
  Membership,
  Upload,
  Job,
  Reaction,
  Conversation,
  Receipt,
} from "../../database/models.js";
import { transaction } from "../../database/connection.js";
import { member } from "../conversations/authorization.js";
import { serializeMessages } from "./serializer.js";
import { sendSchema } from "./validation.js";
import { check } from "../../utils/errors.js";
import { digest } from "../../utils/crypto.js";
import { env } from "../../config/env.js";
import type { Auth } from "../../types/index.js";
import type { z } from "zod";
const links = (text: string) =>
  [...new Set(text.match(/https:\/\/[^\s<>]+/gi) || [])].slice(0, 20);
export async function send(auth: Auth, input: z.infer<typeof sendSchema>) {
  const requestHash = digest(
    JSON.stringify([
      input.conversationId,
      input.text,
      input.attachmentIds,
      input.replyToId || null,
    ]),
  );
  let id: string;
  try {
    id = await transaction(async (session) => {
      const { conversation } = await member(
        auth.userId,
        input.conversationId,
        session,
        true,
      );
      const existing = await Message.findOne({
        senderId: auth.userId,
        clientId: input.clientId,
      })
        .session(session)
        .lean();
      if (existing) {
        check(
          existing.conversationId === input.conversationId &&
            existing.requestHash === requestHash,
          409,
          "IDEMPOTENCY_CONFLICT",
          "This client ID is already used for different content.",
        );
        return existing._id;
      }
      if (input.replyToId)
        check(
          await Message.exists({
            _id: input.replyToId,
            conversationId: input.conversationId,
            deleted: false,
          }).session(session),
          400,
          "INVALID_REPLY",
          "Reply target is unavailable.",
        );
      const uploads = await Upload.find({
        _id: { $in: input.attachmentIds },
        ownerId: auth.userId,
        state: "ready",
        avatarUserId: null,
        avatarConversationId: null,
        $or: [
          { conversationId: null, expiresAt: { $gt: new Date() } },
          { conversationId: input.conversationId },
        ],
      })
        .session(session)
        .lean();
      check(
        uploads.length === input.attachmentIds.length,
        403,
        "INVALID_ATTACHMENT",
        "An attachment is unavailable or belongs to another account.",
      );
      const conv = await Conversation.findByIdAndUpdate(
        input.conversationId,
        { $inc: { seq: 1 } },
        { returnDocument: "after", session },
      );
      const recipients = await Membership.find({
        conversationId: input.conversationId,
        userId: { $ne: auth.userId },
      })
        .select("userId")
        .session(session)
        .lean();
      const [row] = await Message.create(
        [
          {
            recipientIds: recipients.map((m) => m.userId),
            conversationId: input.conversationId,
            senderId: auth.userId,
            clientId: input.clientId,
            requestHash,
            seq: conv!.seq,
            text: input.text,
            attachmentIds: input.attachmentIds,
            replyToId: input.replyToId,
            links: links(input.text),
            version: conversation.revision,
          },
        ],
        { session, ordered: true },
      );
      await Conversation.updateOne(
        { _id: input.conversationId },
        { $set: { lastMessageId: row!.id } },
        { session },
      );
      await Membership.updateMany(
        { conversationId: input.conversationId },
        { $set: { activityAt: row!.createdAt } },
        { session },
      );
      await Upload.updateMany(
        { _id: { $in: input.attachmentIds } },
        { $set: { conversationId: input.conversationId } },
        { session },
      );
      await Job.create(
        [
          { kind: "message", resourceId: row!.id },
          ...(env.FCM_PROJECT_ID
            ? [{ kind: "notify" as const, resourceId: row!.id }]
            : []),
        ],
        { session, ordered: true },
      );
      return row!.id;
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prior = await Message.findOne({
        senderId: auth.userId,
        clientId: input.clientId,
      }).lean();
      if (
        prior &&
        prior.conversationId === input.conversationId &&
        prior.requestHash === requestHash
      ) {
        await member(auth.userId, input.conversationId);
        return (
          await serializeMessages([prior._id], auth.userId, auth.sessionId)
        )[0];
      }
    }
    throw e;
  }
  return (await serializeMessages([id], auth.userId, auth.sessionId))[0];
}
export async function mutate(
  auth: Auth,
  id: string,
  kind: "edit" | "delete" | "reaction",
  value?: string,
) {
  await transaction(async (session) => {
    const row = await Message.findById(id).session(session);
    check(row, 404, "NOT_FOUND", "Message not found.");
    const { membership, conversation } = await member(
      auth.userId,
      row.conversationId,
      session,
      true,
    );
    check(!row.deleted, 409, "DELETED", "This message was deleted.");
    const own = row.senderId === auth.userId;
    if (kind === "edit") {
      check(
        own && Date.now() - row.createdAt.getTime() < 15 * 60000,
        403,
        "EDIT_FORBIDDEN",
        "Only your own recent messages can be edited.",
      );
      row.text = value!;
      row.links = links(value!);
      row.edited = true;
    } else if (kind === "delete") {
      check(
        own || (conversation.kind === "group" && membership.role === "admin"),
        403,
        "DELETE_FORBIDDEN",
        "You cannot delete this message.",
      );
      if (row.attachmentIds.length)
        await Upload.updateMany(
          { _id: { $in: row.attachmentIds } },
          {
            $max: {
              expiresAt: new Date(Date.now() + env.RETENTION_DAYS * 864e5),
            },
          },
          { session },
        );
      row.deleted = true;
      row.text = "";
      row.links = [];
      row.attachmentIds = [];
      row.replyToId = undefined;
      await Reaction.deleteMany({ messageId: id }, { session });
    } else {
      const reaction = await Reaction.findOne({
        messageId: id,
        userId: auth.userId,
      }).session(session);
      if (reaction && reaction.emoji === value)
        await Reaction.deleteOne({ _id: reaction.id }, { session });
      else
        await Reaction.updateOne(
          { messageId: id, userId: auth.userId },
          { $set: { emoji: value } },
          { upsert: true, session },
        );
    }
    row.version = conversation.revision;
    await row.save({ session });
    await Job.create([{ kind: "message", resourceId: id }], {
      session,
      ordered: true,
    });
  });
  return (await serializeMessages([id], auth.userId, auth.sessionId))[0];
}
export async function receipt(
  auth: Auth,
  cid: string,
  messageId: string,
  kind: "read" | "delivered",
) {
  await transaction(async (session) => {
    const { membership } = await member(auth.userId, cid, session);
    const message = await Message.findOne({
      _id: messageId,
      conversationId: cid,
    })
      .session(session)
      .lean();
    check(message, 404, "NOT_FOUND", "Message not found.");
    const previous =
      kind === "read" ? membership.readSeq : membership.deliveredSeq;
    if (message.seq <= previous) return;
    await member(auth.userId, cid, session, true);
    await Membership.updateOne(
      { _id: membership._id },
      {
        $max:
          kind === "read"
            ? { readSeq: message.seq, deliveredSeq: message.seq }
            : { deliveredSeq: message.seq },
      },
      { session },
    );
    await Receipt.updateOne(
      { conversationId: cid, userId: auth.userId },
      {
        $max:
          kind === "read"
            ? { readSeq: message.seq, deliveredSeq: message.seq }
            : { deliveredSeq: message.seq },
      },
      { upsert: true, session },
    );
    await Job.create(
      [
        {
          kind: "receipt",
          resourceId: cid,
          userId: auth.userId,
          fromSeq: previous,
          toSeq: message.seq,
        },
        { kind: "conversation", resourceId: cid },
      ],
      { session, ordered: true },
    );
  });
}
