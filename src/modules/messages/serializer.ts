import type { ClientSession } from "mongoose";
import {
  User,
  Conversation,
  Membership,
  Message,
  Reaction,
  Upload,
  Receipt,
} from "../../database/models.js";
import { transaction } from "../../database/connection.js";
import { serializeUsers } from "../users/serializer.js";
import { attachment } from "../uploads/service.js";
export async function serializeMessages(
  ids: string[],
  viewerId: string,
  sessionId: string,
  existingSession?: ClientSession,
) {
  if (!ids.length) return [];
  const read = async (session: ClientSession) => {
    const messages = await Message.find({ _id: { $in: ids } })
        .session(session)
        .lean(),
      cids = [...new Set(messages.map((m) => m.conversationId))];
    const conversations = await Conversation.find({ _id: { $in: cids } })
      .session(session)
      .lean();
    const members = await Membership.find({ conversationId: { $in: cids } })
      .session(session)
      .lean();
    const allowed = new Set(
      members.filter((m) => m.userId === viewerId).map((m) => m.conversationId),
    );
    const rows = messages.filter((m) => allowed.has(m.conversationId));
    const replies = await Message.find({
      _id: {
        $in: rows.map((m) => m.replyToId).filter((id): id is string => !!id),
      },
      conversationId: { $in: [...allowed] },
    })
      .session(session)
      .lean();
    const receipts = await Receipt.find({ conversationId: { $in: cids } })
      .session(session)
      .lean();
    const allUsers = await User.find({
      _id: {
        $in: [
          ...new Set([
            ...members.map((m) => m.userId),
            ...rows.flatMap((m) => m.recipientIds),
          ]),
        ],
      },
    })
      .session(session)
      .select("_id preferences status")
      .lean();
    const users = await serializeUsers(
      [...new Set([...rows, ...replies].map((m) => m.senderId))],
      viewerId,
      sessionId,
      session,
    );
    const uploads = await Upload.find({
      _id: { $in: rows.flatMap((m) => (m.deleted ? [] : m.attachmentIds)) },
      state: "ready",
    })
      .session(session)
      .lean();
    const reactions = await Reaction.find({
      messageId: { $in: rows.filter((m) => !m.deleted).map((m) => m._id) },
    })
      .session(session)
      .lean();
    const userMap = new Map(users.map((u) => [u.id, u])),
      uploadMap = new Map(uploads.map((u) => [u._id, u])),
      replyMap = new Map(replies.map((m) => [m._id, m])),
      prefMap = new Map(allUsers.map((u) => [u._id, u]));
    const convMap = new Map(conversations.map((c) => [c._id, c]));
    const result = rows.map((m) => {
      const group = members.filter(
          (x) => x.conversationId === m.conversationId,
        ),
        other = m.recipientIds.map(
          (userId) =>
            receipts.find(
              (r) =>
                r.conversationId === m.conversationId && r.userId === userId,
            ) || { userId, readSeq: 0, deliveredSeq: 0 },
        ),
        readBy = other
          .filter(
            (x) =>
              x.readSeq >= m.seq &&
              prefMap.get(x.userId)?.preferences.readReceipts,
          )
          .map((x) => x.userId),
        deliveredTo = other
          .filter((x) => x.deliveredSeq >= m.seq)
          .map((x) => x.userId),
        own = viewerId === m.senderId,
        role = group.find((x) => x.userId === viewerId)?.role;
      const reply = m.replyToId ? replyMap.get(m.replyToId) : undefined;
      const reactionMap: Record<string, string[]> = {};
      for (const r of reactions.filter((r) => r.messageId === m._id)) {
        (reactionMap[r.emoji] ||= []).push(r.userId);
      }
      return {
        id: m._id,
        clientId: own ? m.clientId : undefined,
        conversationId: m.conversationId,
        sender: userMap.get(m.senderId)!,
        text: m.deleted ? "" : m.text,
        createdAt: m.createdAt.toISOString(),
        version: convMap.get(m.conversationId)!.revision,
        status:
          other.length && readBy.length === other.length
            ? "read"
            : other.length && deliveredTo.length === other.length
              ? "delivered"
              : "sent",
        attachments: m.deleted
          ? []
          : m.attachmentIds
              .map((id) => uploadMap.get(id))
              .filter((x): x is NonNullable<typeof x> => !!x)
              .map((a) => attachment(a, sessionId)),
        reactions: m.deleted ? {} : reactionMap,
        edited: m.edited,
        deleted: m.deleted,
        permissions: {
          edit:
            !m.deleted &&
            own &&
            Date.now() - m.createdAt.getTime() < 15 * 60000,
          delete:
            !m.deleted &&
            (own ||
              (convMap.get(m.conversationId)?.kind === "group" &&
                role === "admin")),
        },
        recipientCount: m.recipientIds.length,
        readBy,
        deliveredTo,
        ...(reply && !m.deleted
          ? {
              replyTo: {
                id: reply._id,
                text: reply.deleted ? "Message deleted" : reply.text,
                senderName:
                  userMap.get(reply.senderId)?.name || "Deleted account",
              },
            }
          : {}),
      };
    });
    const map = new Map(result.map((m) => [m.id, m]));
    return ids
      .map((id) => map.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m);
  };
  return existingSession ? read(existingSession) : transaction(read);
}
