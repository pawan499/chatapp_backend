import { redis } from "./redis.js";
const local = new Map<string, Map<string, number>>();
export async function touchPresence(userId: string, socketId: string) {
  const expiry = Date.now() + 90000;
  if (redis) {
    await redis.zAdd(`presence:${userId}`, { score: expiry, value: socketId });
    await redis.expire(`presence:${userId}`, 120);
  } else {
    let map = local.get(userId);
    if (!map) {
      map = new Map();
      local.set(userId, map);
    }
    map.set(socketId, expiry);
  }
}
export async function removePresence(userId: string, socketId: string) {
  if (redis) await redis.zRem(`presence:${userId}`, socketId);
  else {
    local.get(userId)?.delete(socketId);
    if (!local.get(userId)?.size) local.delete(userId);
  }
}
export async function onlineUsers(ids: string[]) {
  if (redis) {
    const result = await Promise.all(
      ids.map((id) => redis!.zCount(`presence:${id}`, Date.now(), "+inf")),
    );
    return new Set(ids.filter((_, i) => Number(result[i]) > 0));
  }
  return new Set(
    ids.filter((id) =>
      [...(local.get(id)?.values() || [])].some((exp) => exp > Date.now()),
    ),
  );
}
