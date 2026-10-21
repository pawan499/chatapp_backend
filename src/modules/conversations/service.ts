import { env } from "../../config/env.js";
import {
  Conversation,
  Membership,
  User,
  Block,
  Job,
  Upload,
} from "../../database/models.js";
import { transaction } from "../../database/connection.js";
import { check } from "../../utils/errors.js";
import { serializeConversations } from "./serializer.js";
import { member } from "./authorization.js";
import type { Auth } from "../../types/index.js";
export async function createConversation(
  auth: Auth,
  data: {
    kind: "direct" | "group";
    userId?: string;
    name?: string;
    memberIds?: string[];
  },
) {
  const ids = [
    ...new Set([
      auth.userId,
      ...(data.kind === "direct" ? [data.userId!] : data.memberIds || []),
    ]),
  ].sort();
  check(
    ids.length >= 2 && ids.length <= 256,
    400,
    "MEMBERS",
    "Choose between 2 and 256 participants.",
  );
  const directKey = data.kind === "direct" ? ids.join(":") : undefined;
  if (directKey) {
    const existing = await Conversation.findOne({ directKey }).lean();
    if (existing)
      return (
        await serializeConversations(
          [existing._id],
          auth.userId,
          auth.sessionId,
        )
      )[0];
  }
  let cid: string;
  try {
    cid = await transaction(async (session) => {
      check(
        (await User.countDocuments({
          _id: { $in: ids },
          status: "active",
          verified: true,
        }).session(session)) === ids.length,
        400,
        "CONTACT_UNAVAILABLE",
        "Some selected accounts are unavailable.",
      );
      check(
        !(await Block.exists({
          $or: [
            { ownerId: auth.userId, targetId: { $in: ids } },
            { targetId: auth.userId, ownerId: { $in: ids } },
          ],
        }).session(session)),
        403,
        "BLOCKED",
        "Some selected accounts are unavailable.",
      );
      for (const id of ids) {
        const updated = await User.updateOne(
          { _id: id, conversationCount: { $lt: 500 } },
          { $inc: { conversationCount: 1 } },
          { session },
        );
        check(
          updated.modifiedCount,
          409,
          "CONVERSATION_LIMIT",
          "A participant has reached the conversation limit.",
        );
      }
      const [row] = await Conversation.create(
        [
          {
            kind: data.kind,
            name: data.name || "",
            directKey,
            memberCount: ids.length,
            adminCount: data.kind === "group" ? 1 : 0,
          },
        ],
        { session, ordered: true },
      );
      await Membership.insertMany(
        ids.map((userId) => ({
          userId,
          conversationId: row!.id,
          role:
            data.kind === "group" && userId === auth.userId
              ? "admin"
              : "member",
        })),
        { session },
      );
      await Job.create([{ kind: "conversation", resourceId: row!.id }], {
        session,
        ordered: true,
      });
      return row!.id;
    });
  } catch (e) {
    if (directKey && (e as { code?: number }).code === 11000) {
      const row = await Conversation.findOne({ directKey }).lean();
      if (row)
        return (
          await serializeConversations([row._id], auth.userId, auth.sessionId)
        )[0];
    }
    throw e;
  }
  return (await serializeConversations([cid], auth.userId, auth.sessionId))[0];
}
export async function updateConversation(
  auth: Auth,
  cid: string,
  data: {
    name?: string;
    description?: string;
    avatarId?: string;
    pinned?: boolean;
    muted?: boolean;
    archived?: boolean;
  },
) {
  await transaction(async (session) => {
    const { membership, conversation } = await member(
      auth.userId,
      cid,
      session,
      true,
    );
    if (
      data.name !== undefined ||
      data.description !== undefined ||
      data.avatarId !== undefined
    ) {
      check(
        conversation.kind === "group" && membership.role === "admin",
        403,
        "ADMIN_REQUIRED",
        "Only group admins can edit group details.",
      );
      if (data.avatarId) {
        if (conversation.avatarId && conversation.avatarId !== data.avatarId)
          await Upload.updateOne(
            { _id: conversation.avatarId },
            {
              $max: {
                expiresAt: new Date(Date.now() + env.RETENTION_DAYS * 864e5),
              },
            },
            { session },
          );
        const image = await Upload.findOne({
          _id: data.avatarId,
          ownerId: auth.userId,
          state: "ready",
          conversationId: null,
          avatarUserId: null,
          $or: [{ avatarConversationId: null }, { avatarConversationId: cid }],
        }).session(session);
        check(
          image && image.mime.startsWith("image/"),
          400,
          "INVALID_AVATAR",
          "Choose an unassigned image owned by your account.",
        );
        await Upload.updateOne(
          { _id: image.id },
          { $set: { avatarConversationId: cid } },
          { session },
        );
      }
      await Conversation.updateOne(
        { _id: cid },
        {
          $set: {
            ...(data.avatarId ? { avatarId: data.avatarId } : {}),
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined
              ? { description: data.description }
              : {}),
          },
        },
        { session },
      );
    }
    await Membership.updateOne(
      { userId: auth.userId, conversationId: cid },
      {
        $set: {
          ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
          ...(data.muted !== undefined ? { muted: data.muted } : {}),
          ...(data.archived !== undefined ? { archived: data.archived } : {}),
        },
      },
      { session },
    );
    await Job.create([{ kind: "conversation", resourceId: cid }], {
      session,
      ordered: true,
    });
  });
}
