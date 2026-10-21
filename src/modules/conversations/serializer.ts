import { transaction } from "../../database/connection.js";
import {
  Membership,
  Conversation,
  Message,
  Upload,
} from "../../database/models.js";
import { mediaUrl } from "../uploads/service.js";
import { serializeUsers } from "../users/serializer.js";
import { serializeMessages } from "../messages/serializer.js";
export async function serializeConversations(
  ids: string[],
  viewerId: string,
  sessionId: string,
) {
  return transaction(async (session) => {
    const rows = await Conversation.find({ _id: { $in: ids } })
      .session(session)
      .lean();
    const avatars = await Upload.find({
      _id: {
        $in: rows.map((c) => c.avatarId).filter((id): id is string => !!id),
      },
      state: "ready",
    })
      .session(session)
      .lean();
    const avatarMap = new Map(avatars.map((a) => [a._id, a]));
    const memberships = await Membership.find({
      conversationId: { $in: ids },
    })
      .session(session)
      .lean();
    const own = new Map(
      memberships
        .filter((m) => m.userId === viewerId)
        .map((m) => [m.conversationId, m]),
    );
    const users = await serializeUsers(
      [...new Set(memberships.map((m) => m.userId))],
      viewerId,
      sessionId,
      session,
    );
    const userMap = new Map(users.map((u) => [u.id, u]));
    const messages = await serializeMessages(
        rows.map((c) => c.lastMessageId).filter((id): id is string => !!id),
        viewerId,
        sessionId,
        session,
      ),
      messageMap = new Map(messages.map((m) => [m.id, m]));
    const unread = own.size
      ? await Message.aggregate<{ _id: string; count: number; first: string }>([
          {
            $match: {
              $or: ids
                .filter((id) => own.has(id))
                .map((id) => ({
                  conversationId: id,
                  seq: { $gt: own.get(id)!.readSeq },
                  senderId: { $ne: viewerId },
                  deleted: false,
                })),
            },
          },
          { $sort: { seq: 1 } },
          {
            $group: {
              _id: "$conversationId",
              count: { $sum: 1 },
              first: { $first: "$_id" },
            },
          },
        ]).session(session)
      : [];
    const unreadMap = new Map(unread.map((u) => [u._id, u]));
    const map = new Map(
      rows
        .filter((c) => own.has(c._id))
        .map((c) => {
          const all = memberships.filter((m) => m.conversationId === c._id),
            peer = all.find((m) => m.userId !== viewerId),
            setting = own.get(c._id)!;
          return [
            c._id,
            {
              id: c._id,
              name:
                c.kind === "group"
                  ? c.name
                  : userMap.get(peer?.userId || viewerId)?.name ||
                    "Deleted account",
              kind: c.kind,
              members: all.map((m) => userMap.get(m.userId)).filter(Boolean),
              adminIds: all
                .filter((m) => m.role === "admin")
                .map((m) => m.userId),
              unread: unreadMap.get(c._id)?.count || 0,
              firstUnreadMessageId: unreadMap.get(c._id)?.first,
              pinned: setting.pinned,
              muted: setting.muted,
              archived: setting.archived,
              updatedAt: setting.activityAt.toISOString(),
              lastMessage: c.lastMessageId
                ? messageMap.get(c.lastMessageId)
                : undefined,
              avatar:
                c.kind === "direct"
                  ? userMap.get(peer?.userId || viewerId)?.avatar
                  : c.avatarId && avatarMap.has(c.avatarId)
                    ? mediaUrl(avatarMap.get(c.avatarId)!, sessionId)
                    : undefined,
              description: c.description,
            },
          ] as const;
        }),
    );
    return ids.map((id) => map.get(id)).filter(Boolean);
  });
}
