import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import {
  Upload,
  Session,
  User,
  Membership,
  Conversation,
  Message,
  Block,
  type UploadDoc,
} from "../../database/models.js";
import { env } from "../../config/env.js";
import { storage } from "../../infrastructure/storage.js";
import { validateFile } from "./validation.js";
import { check } from "../../utils/errors.js";
import { equal } from "../../utils/crypto.js";
import type { Auth } from "../../types/index.js";
const sign = (value: string) =>
  createHmac("sha256", env.MEDIA_SIGNING_SECRET).update(value).digest("hex");
export function mediaUrl(row: Pick<UploadDoc, "_id">, sessionId: string) {
  const expires = Math.floor(Date.now() / 1000) + 180;
  const signature = sign(`${row._id}.${sessionId}.${expires}`);
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/api/v1/media/${row._id}?session=${sessionId}&expires=${expires}&signature=${signature}`;
}
export const attachment = (row: UploadDoc, sessionId: string) => ({
  id: row._id,
  url: mediaUrl(row, sessionId),
  name: row.name,
  mime: row.mime,
  size: row.size,
});
export function safeName(name: string) {
  return name.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 120) || "Attachment";
}
export async function initUpload(
  auth: Auth,
  data: { name: string; mime: string; size: number },
) {
  const uid = randomUUID(),
    key = `quarantine/${auth.userId}/${uid}`;
  await Upload.create({
    _id: uid,
    ownerId: auth.userId,
    sessionId: auth.sessionId,
    key,
    name: safeName(data.name),
    mime: data.mime,
    size: data.size,
    expiresAt: new Date(Date.now() + 864e5),
  });
  return {
    id: uid,
    uploadUrl: await storage.signedPut(key, data.mime, data.size),
    expiresIn: 300,
    headers: {
      "Content-Type": data.mime,
      "x-amz-server-side-encryption": "AES256",
    },
  };
}
export async function completeUpload(auth: Auth, id: string) {
  const row = await Upload.findOne({ _id: id, ownerId: auth.userId });
  check(row, 404, "NOT_FOUND", "Upload not found.");
  if (row.state === "ready") return attachment(row.toObject(), auth.sessionId);
  check(
    row.state === "pending" && row.expiresAt > new Date(),
    409,
    "UPLOAD_EXPIRED",
    "Upload expired. Start again.",
  );
  const data = await storage.buffer(row.key);
  check(
    data.length === row.size,
    422,
    "SIZE_MISMATCH",
    "Uploaded file size does not match the declared size.",
  );
  const result = await validateFile(data);
  const finalKey = `private/${auth.userId}/${row.id}`;
  await storage.put(finalKey, result.data, result.mime);
  const updated = await Upload.findOneAndUpdate(
    { _id: id, state: "pending" },
    {
      $set: {
        key: finalKey,
        size: result.data.length,
        mime: result.mime,
        state: "ready",
      },
    },
    { returnDocument: "after" },
  );
  check(updated, 409, "UPLOAD_CONFLICT", "Upload is being completed. Retry.");
  await storage.remove(row.key);
  return attachment(updated.toObject(), auth.sessionId);
}
export async function multipartUpload(auth: Auth, name: string, data: Buffer) {
  const id = randomUUID(),
    key = `private/${auth.userId}/${id}`;
  await Upload.create({
    _id: id,
    ownerId: auth.userId,
    sessionId: auth.sessionId,
    key,
    name: safeName(name),
    mime: "application/octet-stream",
    size: data.length,
    expiresAt: new Date(Date.now() + 864e5),
  });
  const result = await validateFile(data);
  await storage.put(key, result.data, result.mime);
  const row = await Upload.findByIdAndUpdate(
    id,
    { $set: { state: "ready", mime: result.mime, size: result.data.length } },
    { returnDocument: "after" },
  );
  return attachment(row!.toObject(), auth.sessionId);
}
const signedQuery = z
  .object({
    session: z.uuid(),
    expires: z.coerce.number().int(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function authorizeMedia(id: string, query: unknown) {
  const q = signedQuery.parse(query);
  check(
    q.expires >= Date.now() / 1000 &&
      equal(sign(`${id}.${q.session}.${q.expires}`), q.signature),
    403,
    "LINK_EXPIRED",
    "This file link has expired.",
  );
  const session = await Session.findOne({
    _id: q.session,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  check(
    session && (await User.exists({ _id: session.userId, status: "active" })),
    401,
    "SESSION_EXPIRED",
    "Session expired.",
  );
  const row = await Upload.findOne({ _id: id, state: "ready" }).lean();
  check(row, 404, "NOT_FOUND", "File not found.");
  if (row.conversationId) {
    check(
      await Membership.exists({
        conversationId: row.conversationId,
        userId: session.userId,
      }),
      403,
      "FORBIDDEN",
      "You cannot access this file.",
    );
    check(
      await Message.exists({
        conversationId: row.conversationId,
        attachmentIds: id,
        deleted: false,
      }),
      404,
      "NOT_FOUND",
      "File is no longer available.",
    );
  } else if (row.avatarConversationId) {
    check(
      (await Membership.exists({
        conversationId: row.avatarConversationId,
        userId: session.userId,
      })) &&
        (await Conversation.exists({
          _id: row.avatarConversationId,
          avatarId: id,
        })),
      403,
      "FORBIDDEN",
      "Group avatar unavailable.",
    );
  } else if (row.avatarUserId) {
    check(
      await User.exists({
        _id: row.avatarUserId,
        status: "active",
        avatarId: id,
      }),
      404,
      "NOT_FOUND",
      "Avatar not found.",
    );
    check(
      !(await Block.exists({
        $or: [
          { ownerId: session.userId, targetId: row.avatarUserId },
          { ownerId: row.avatarUserId, targetId: session.userId },
        ],
      })),
      403,
      "FORBIDDEN",
      "Avatar unavailable.",
    );
  } else
    check(
      row.ownerId === session.userId,
      403,
      "FORBIDDEN",
      "You cannot access this file.",
    );
  if (row.conversationId) {
    const peers = await Membership.find({ conversationId: row.conversationId })
      .select("userId")
      .limit(257)
      .lean();
    if (peers.length === 2)
      check(
        !(await Block.exists({
          $or: [
            {
              ownerId: session.userId,
              targetId: { $in: peers.map((p) => p.userId) },
            },
            {
              targetId: session.userId,
              ownerId: { $in: peers.map((p) => p.userId) },
            },
          ],
        })),
        403,
        "BLOCKED",
        "This file is unavailable.",
      );
  }
  return row;
}

export async function metadata(auth: Auth, id: string) {
  const url = new URL(mediaUrl({ _id: id }, auth.sessionId));
  const row = await authorizeMedia(id, Object.fromEntries(url.searchParams));
  return attachment(row, auth.sessionId);
}
