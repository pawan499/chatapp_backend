import type { ClientSession } from "mongoose";
import { User, Upload, Block } from "../../database/models.js";
import { onlineUsers } from "../../infrastructure/presence.js";
import { mediaUrl } from "../uploads/service.js";
export async function serializeUsers(
  ids: string[],
  viewerId: string,
  sessionId: string,
  session?: ClientSession,
) {
  const rows = await User.find({ _id: { $in: ids } })
    .session(session || null)
    .lean();
  // The MongoDB driver does not support parallel operations in a transaction.
  const avatars = await Upload.find({
    _id: {
      $in: rows.map((u) => u.avatarId).filter((id): id is string => !!id),
    },
    state: "ready",
  })
    .session(session || null)
    .lean();
  const blocks = await Block.find({
    $or: [
      { ownerId: viewerId, targetId: { $in: ids } },
      { targetId: viewerId, ownerId: { $in: ids } },
    ],
  })
    .session(session || null)
    .lean();
  const online = await onlineUsers(ids);
  const blocked = new Set(
      blocks.map((b) => (b.ownerId === viewerId ? b.targetId : b.ownerId)),
    ),
    pictures = new Map(avatars.map((a) => [a._id, a]));
  return rows.map((u) => {
    const visible = u.status === "active" && !blocked.has(u._id);
    return {
      id: u._id,
      name: u.status === "active" ? u.name : "Deleted account",
      email: u.status === "active" ? u.email : "",
      bio: visible ? u.bio : "",
      ...(visible && u.avatarId && pictures.has(u.avatarId)
        ? { avatar: mediaUrl(pictures.get(u.avatarId)!, sessionId) }
        : {}),
      ...(visible && u.preferences.lastSeen
        ? {
            online: online.has(u._id),
            ...(u.lastSeen ? { lastSeen: u.lastSeen.toISOString() } : {}),
          }
        : {}),
    };
  });
}
