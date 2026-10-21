import { z } from "zod";
import { check } from "./errors.js";
export const id = z.uuid();
export const listQuery = z
  .object({
    cursor: z.string().max(1024).optional(),
    search: z.string().trim().max(100).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export function encodeCursor(data: unknown) {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}
export function decodeCursor<T>(
  cursor: string | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  if (!cursor) return;
  try {
    return schema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString()),
    );
  } catch {
    check(false, 400, "INVALID_CURSOR", "Invalid pagination cursor.");
  }
}
export const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function page<T>(
  items: T[],
  limit: number,
  cursor: (last: T) => unknown,
) {
  const hasMore = items.length > limit;
  const rows = items.slice(0, limit);
  return {
    items: rows,
    nextCursor:
      hasMore && rows.length ? encodeCursor(cursor(rows.at(-1)!)) : null,
  };
}
