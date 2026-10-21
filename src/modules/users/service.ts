import argon2 from "argon2";
import {
  User,
  Upload,
  Job,
  Device,
  Session,
  Block,
} from "../../database/models.js";
import { transaction } from "../../database/connection.js";
import { check } from "../../utils/errors.js";
import { serializeUsers } from "./serializer.js";
import { audit } from "../../infrastructure/logger.js";
import { digest, encrypt } from "../../utils/crypto.js";
import { env } from "../../config/env.js";
import type { Auth } from "../../types/index.js";
export async function profile(
  auth: Auth,
  data: { name: string; bio?: string; avatarId?: string },
) {
  await transaction(async (session) => {
    if (data.avatarId) {
      const photo = await Upload.findOne({
        _id: data.avatarId,
        ownerId: auth.userId,
        state: "ready",
        conversationId: null,
        avatarUserId: null,
        avatarConversationId: null,
      }).session(session);
      check(
        photo && photo.mime.startsWith("image/"),
        400,
        "INVALID_AVATAR",
        "Select an unassigned image owned by your account.",
      );
      const previous = await User.findById(auth.userId)
        .select("avatarId")
        .session(session)
        .lean();
      if (previous?.avatarId && previous.avatarId !== photo.id)
        await Upload.updateOne(
          { _id: previous.avatarId },
          {
            $max: {
              expiresAt: new Date(Date.now() + env.RETENTION_DAYS * 864e5),
            },
          },
          { session },
        );
      await Upload.updateOne(
        { _id: photo.id },
        { $set: { avatarUserId: auth.userId } },
        { session },
      );
    }
    await User.updateOne(
      { _id: auth.userId, status: "active" },
      { $set: { ...data, profileComplete: true } },
      { session },
    );
  });
  return (await serializeUsers([auth.userId], auth.userId, auth.sessionId))[0];
}
export async function updatePreferences(
  auth: Auth,
  data: Record<string, boolean>,
) {
  const update = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [`preferences.${key}`, value]),
  );
  const row = await User.findByIdAndUpdate(
    auth.userId,
    { $set: update },
    { returnDocument: "after" },
  ).lean();
  return row!.preferences;
}
export async function setBlock(auth: Auth, targetId: string, blocked: boolean) {
  check(
    targetId !== auth.userId &&
      (await User.exists({ _id: targetId, status: "active" })),
    400,
    "INVALID_CONTACT",
    "Choose another active account.",
  );
  await transaction(async (session) => {
    for (const id of [auth.userId, targetId].sort())
      await User.updateOne(
        { _id: id },
        { $inc: { policyVersion: 1 } },
        { session },
      );
    if (blocked) {
      check(
        (await Block.countDocuments({ ownerId: auth.userId }).session(
          session,
        )) < 500,
        409,
        "BLOCK_LIMIT",
        "The block list limit is 500 contacts.",
      );
      await Block.updateOne(
        { ownerId: auth.userId, targetId },
        { $setOnInsert: { ownerId: auth.userId, targetId } },
        { upsert: true, session },
      );
    } else
      await Block.deleteOne({ ownerId: auth.userId, targetId }, { session });
  });
  audit(
    blocked ? "contact_blocked" : "contact_unblocked",
    auth.userId,
    targetId,
  );
}
export async function registerDevice(
  auth: Auth,
  token: string,
  platform: string,
) {
  check(
    env.FCM_PROJECT_ID,
    503,
    "PUSH_DISABLED",
    "Push notifications are not configured.",
  );
  const tokenHash = digest(token);
  await transaction(async (session) => {
    await User.updateOne(
      { _id: auth.userId },
      { $inc: { policyVersion: 1 } },
      { session },
    );
    const existing = await Device.findOne({ tokenHash })
      .session(session)
      .lean();
    if (existing?.userId !== auth.userId)
      check(
        (await Device.countDocuments({ userId: auth.userId }).session(
          session,
        )) < 20,
        409,
        "DEVICE_LIMIT",
        "Remove an old device before adding another.",
      );
    await Device.findOneAndUpdate(
      { tokenHash },
      {
        $set: {
          userId: auth.userId,
          sessionId: auth.sessionId,
          tokenHash,
          encryptedToken: encrypt(token),
          platform,
        },
      },
      { upsert: true, returnDocument: "after", session },
    );
  });
}

export async function deleteAccount(auth: Auth, password: string) {
  const current = await User.findOne({ _id: auth.userId, status: "active" })
    .select("+passwordHash")
    .lean();
  check(
    current &&
      (await argon2.verify(current.passwordHash, password).catch(() => false)),
    403,
    "REAUTHENTICATION_REQUIRED",
    "Confirm your current password to delete your account.",
  );
  await transaction(async (session) => {
    const changed = await User.updateOne(
      {
        _id: auth.userId,
        status: "active",
        passwordHash: current.passwordHash,
      },
      {
        $set: {
          status: "deleted",
          name: "Deleted account",
          email: `deleted-${auth.userId}@deleted.invalid`,
          bio: "",
          passwordHash: "deleted",
          verified: false,
        },
        $unset: { avatarId: 1, lastSeen: 1 },
      },
      { session },
    );
    check(
      changed.modifiedCount,
      403,
      "REAUTHENTICATION_REQUIRED",
      "Your account changed. Please sign in again.",
    );
    if (current.avatarId)
      await Upload.updateOne(
        { _id: current.avatarId },
        {
          $max: {
            expiresAt: new Date(Date.now() + env.RETENTION_DAYS * 864e5),
          },
        },
        { session },
      );
    await Session.updateMany(
      { userId: auth.userId },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await Device.deleteMany({ userId: auth.userId }, { session });
    await Block.deleteMany(
      { $or: [{ ownerId: auth.userId }, { targetId: auth.userId }] },
      { session },
    );
    await Job.create(
      [
        { kind: "revoke", resourceId: auth.userId },
        { kind: "account_cleanup", resourceId: auth.userId },
      ],
      { session, ordered: true },
    );
  });
  audit("account_deleted", auth.userId);
}
