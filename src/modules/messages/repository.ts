import { Message } from "../../database/models.js";
export function findHistory(
  conversationId: string,
  limit: number,
  search = "",
  beforeSeq?: number,
) {
  return Message.find({
    conversationId,
    ...(beforeSeq ? { seq: { $lt: beforeSeq } } : {}),
    ...(search ? { $text: { $search: search }, deleted: false } : {}),
  })
    .select("_id seq")
    .sort({ seq: -1 })
    .limit(limit + 1)
    .lean();
}
