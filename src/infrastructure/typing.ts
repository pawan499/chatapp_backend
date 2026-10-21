import { redis } from "./redis.js";
import { User } from "../database/models.js";
const entries = new Map<string, Map<string, number>>();
export async function setTyping(
  conversationId: string,
  userId: string,
  active: boolean,
) {
  const key = `typing:${conversationId}`,
    now = Date.now();
  let ids: string[];
  if (redis) {
    if (active) await redis.zAdd(key, { score: now + 5000, value: userId });
    else await redis.zRem(key, userId);
    await redis.zRemRangeByScore(key, 0, now);
    await redis.expire(key, 10);
    ids = await redis.zRangeByScore(key, now, "+inf");
  } else {
    let row = entries.get(conversationId);
    if (!row) {
      row = new Map();
      entries.set(conversationId, row);
    }
    if (active) row.set(userId, now + 5000);
    else row.delete(userId);
    for (const [id, expires] of row) if (expires <= now) row.delete(id);
    ids = [...row.keys()];
    if (!row.size) entries.delete(conversationId);
  }
  return User.find({ _id: { $in: ids }, status: "active" })
    .select("_id name")
    .limit(256)
    .lean();
}
