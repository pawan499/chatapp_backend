import {
  Conversation,
  Membership,
  User,
  Job,
  Block,
} from "../../database/models.js";
import { member } from "../conversations/authorization.js";
import { transaction } from "../../database/connection.js";
import { check } from "../../utils/errors.js";
import { audit } from "../../infrastructure/logger.js";
import type { Auth } from "../../types/index.js";
export async function membershipAction(
  auth: Auth,
  cid: string,
  userId: string,
  action: "add" | "remove" | "promote" | "demote" | "leave",
) {
  await transaction(async (session) => {
    const { membership, conversation } = await member(
      auth.userId,
      cid,
      session,
      true,
    );
    check(
      conversation.kind === "group",
      400,
      "GROUP_REQUIRED",
      "This action is only available in groups.",
    );
    check(
      action === "leave" ? userId === auth.userId : membership.role === "admin",
      403,
      "ADMIN_REQUIRED",
      "Only group admins can manage members.",
    );
    const target = await Membership.findOne({
      userId,
      conversationId: cid,
    }).session(session);
    if (action === "add") {
      check(!target, 409, "ALREADY_MEMBER", "This person is already a member.");
      check(
        conversation.memberCount < 256,
        409,
        "GROUP_FULL",
        "This group has reached 256 members.",
      );
      check(
        !(await Block.exists({
          $or: [
            { ownerId: auth.userId, targetId: userId },
            { ownerId: userId, targetId: auth.userId },
          ],
        }).session(session)),
        403,
        "BLOCKED",
        "This contact is unavailable.",
      );
      const result = await User.updateOne(
        {
          _id: userId,
          status: "active",
          verified: true,
          conversationCount: { $lt: 500 },
        },
        { $inc: { conversationCount: 1 } },
        { session },
      );
      check(
        result.modifiedCount,
        400,
        "CONTACT_UNAVAILABLE",
        "This contact cannot be added.",
      );
      await Membership.create(
        [
          {
            userId,
            conversationId: cid,
            readSeq: conversation.seq,
            deliveredSeq: conversation.seq,
          },
        ],
        { session, ordered: true },
      );
      await Conversation.updateOne(
        { _id: cid },
        { $inc: { memberCount: 1 } },
        { session },
      );
    } else {
      check(target, 404, "NOT_FOUND", "Member not found.");
      if (action === "promote" || action === "demote") {
        const next = action === "promote" ? "admin" : "member";
        if (next !== target.role) {
          check(
            next === "admin" || conversation.adminCount > 1,
            409,
            "LAST_ADMIN",
            "Assign another admin first.",
          );
          target.role = next;
          await target.save({ session });
          await Conversation.updateOne(
            { _id: cid },
            { $inc: { adminCount: next === "admin" ? 1 : -1 } },
            { session },
          );
        }
      } else {
        check(
          target.role !== "admin" ||
            conversation.adminCount > 1 ||
            conversation.memberCount === 1,
          409,
          "LAST_ADMIN",
          "Assign another admin before leaving.",
        );
        await Membership.deleteOne({ _id: target.id }, { session });
        await Conversation.updateOne(
          { _id: cid },
          {
            $inc: {
              memberCount: -1,
              adminCount: target.role === "admin" ? -1 : 0,
            },
          },
          { session },
        );
        await User.updateOne(
          { _id: userId },
          { $inc: { conversationCount: -1 } },
          { session },
        );
      }
    }
    await Job.create(
      [
        { kind: "conversation", resourceId: cid },
        { kind: "membership", resourceId: cid, userId },
      ],
      { session, ordered: true },
    );
  });
  audit(`group_${action}`, auth.userId, userId);
}
