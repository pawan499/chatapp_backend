import type { ClientSession } from "mongoose";
import {
  Membership,
  Conversation,
  Block,
  User,
} from "../../database/models.js";
import { check } from "../../utils/errors.js";
export async function member(
  userId: string,
  conversationId: string,
  session?: ClientSession,
  write = false,
) {
  const membership = await Membership.findOne({ userId, conversationId })
    .session(session || null)
    .lean();
  check(
    membership,
    403,
    "NOT_A_MEMBER",
    "You are not a member of this conversation.",
  );
  const conversation = write
    ? await Conversation.findByIdAndUpdate(
        conversationId,
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      ).lean()
    : await Conversation.findById(conversationId)
        .session(session || null)
        .lean();
  check(conversation, 404, "NOT_FOUND", "Conversation not found.");
  if (conversation.kind === "direct" && write) {
    const members = await Membership.find({ conversationId })
      .session(session || null)
      .lean();
    const ids = members.map((m) => m.userId).sort();
    for (const id of ids)
      await User.updateOne(
        { _id: id, status: "active" },
        { $inc: { policyVersion: 1 } },
        { session },
      );
    check(
      (await User.countDocuments({
        _id: { $in: ids },
        status: "active",
      }).session(session || null)) === 2,
      410,
      "CONTACT_UNAVAILABLE",
      "This account is no longer available.",
    );
    check(
      !(await Block.exists({
        $or: ids.map((ownerId) => ({ ownerId, targetId: { $in: ids } })),
      }).session(session || null)),
      403,
      "BLOCKED",
      "This conversation is blocked.",
    );
  }
  return { membership, conversation };
}
