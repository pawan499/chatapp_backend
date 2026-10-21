import argon2 from "argon2";
import { randomInt, randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import {
  User,
  Session,
  Challenge,
  Device,
  Job,
} from "../../database/models.js";
import { transaction } from "../../database/connection.js";
import { digest, equal, encrypt } from "../../utils/crypto.js";
import { check } from "../../utils/errors.js";
import { issue, verifyRefresh } from "./tokens.js";

import { consume } from "../../infrastructure/rateLimit.js";
import { audit } from "../../infrastructure/logger.js";
import { serializeUsers } from "../users/serializer.js";
export const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
let dummy: Promise<string> | undefined;
async function newChallenge(userId: string, kind: "verify" | "reset") {
  const code = String(
    randomInt(
      kind === "verify" ? 100000 : 10000000,
      kind === "verify" ? 1000000 : 100000000,
    ),
  );
  const row = await Challenge.create({
    userId,
    kind,
    digest: digest(code),
    expiresAt: new Date(Date.now() + 600000),
  });
  await Job.create({ kind: "mail", resourceId: row.id, secret: encrypt(code) });
  return { challengeId: row.id };
}
async function newSession(userId: string, deviceName: string) {
  const sid = randomUUID(),
    tokens = await issue(userId, sid);
  await transaction(async (session) => {
    check(
      await User.findOneAndUpdate(
        { _id: userId, status: "active", verified: true },
        { $inc: { policyVersion: 1 } },
        { session, returnDocument: "after" },
      ),
      401,
      "INVALID_CREDENTIALS",
      "Account is unavailable.",
    );
    const current = await Session.find({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: 1 })
      .limit(100)
      .session(session)
      .lean();
    if (current.length >= 100) {
      const oldest = current[0]!;
      await Session.updateOne(
        { _id: oldest._id },
        { $set: { revokedAt: new Date() } },
        { session },
      );
      await Device.deleteMany({ sessionId: oldest._id }, { session });
      await Job.create([{ kind: "revoke", resourceId: oldest._id, userId }], {
        session,
        ordered: true,
      });
    }
    await Session.create(
      [
        {
          _id: sid,
          userId,
          digest: digest(tokens.refreshToken),
          deviceName,
          expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 864e5),
        },
      ],
      { session, ordered: true },
    );
  });
  const [user] = await serializeUsers([userId], userId, sid);
  return {
    ...tokens,
    user,
    needsProfileSetup: !(await User.findById(userId).lean())!.profileComplete,
  };
}
export async function register(data: {
  name: string;
  email: string;
  password: string;
  deviceName: string;
}) {
  const passwordHash = await hashPassword(data.password);
  let user;
  try {
    user = await User.create({
      name: data.name,
      email: data.email,
      passwordHash,
      verified: !env.EMAIL_VERIFICATION,
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000)
      check(
        false,
        409,
        "REGISTRATION_UNAVAILABLE",
        "Unable to register with these details.",
      );
    throw e;
  }
  audit("account_registered", user.id);
  return env.EMAIL_VERIFICATION
    ? newChallenge(user.id, "verify")
    : newSession(user.id, data.deviceName);
}
export async function login(data: {
  email: string;
  password: string;
  deviceName: string;
}) {
  await consume("login-identity", data.email, 10, 900);
  const user = await User.findOne({
    email: data.email,
    status: "active",
  }).select("+passwordHash");
  dummy ||= hashPassword(randomUUID());
  const valid = await argon2
    .verify(user?.passwordHash || (await dummy), data.password)
    .catch(() => false);
  check(
    user && valid,
    401,
    "INVALID_CREDENTIALS",
    "Email or password is incorrect.",
  );
  if (!user.verified) return newChallenge(user.id, "verify");
  audit("session_created", user.id);
  return newSession(user.id, data.deviceName);
}
async function consumeChallenge(
  challengeId: string,
  code: string,
  kind: "verify" | "reset",
  session: import("mongoose").ClientSession,
) {
  const row = await Challenge.findOneAndUpdate(
    {
      _id: challengeId,
      kind,
      usedAt: null,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: 5 },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: "after", session },
  ).select("+digest");
  if (!row || !equal(row.digest, digest(code))) return null;
  await Challenge.updateOne(
    { _id: row.id },
    { $set: { usedAt: new Date() } },
    { session },
  );
  return row;
}
export async function verifyAccount(challengeId: string, code: string) {
  const userId = await transaction(async (session) => {
    const row = await consumeChallenge(challengeId, code, "verify", session);
    if (!row) return null;
    await User.updateOne(
      { _id: row.userId, status: "active" },
      { $set: { verified: true } },
      { session },
    );
    await Challenge.updateMany(
      { userId: row.userId, kind: "verify", usedAt: null },
      { $set: { usedAt: new Date() } },
      { session },
    );
    return row.userId;
  });
  check(userId, 400, "INVALID_CODE", "Code is invalid or expired.");
  return newSession(userId, "Verified mobile device");
}
export async function forgotPassword(email: string) {
  await consume("reset-identity", email, 3, 3600);
  const user = await User.findOne({ email, status: "active" }).lean();
  if (user) await newChallenge(user._id, "reset");
}
export async function resetPassword(
  email: string,
  code: string,
  password: string,
) {
  await consume("reset-code", email, 10, 900);
  const user = await User.findOne({ email, status: "active" }).lean();
  check(user, 400, "INVALID_CODE", "Code is invalid or expired.");
  const row = await Challenge.findOne({
    userId: user._id,
    kind: "reset",
    usedAt: null,
  })
    .sort({ createdAt: -1 })
    .lean();
  check(row, 400, "INVALID_CODE", "Code is invalid or expired.");
  const passwordHash = await hashPassword(password);
  const valid = await transaction(async (session) => {
    const challenge = await consumeChallenge(row._id, code, "reset", session);
    if (!challenge) return false;
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash, verified: true } },
      { session },
    );
    await Challenge.updateMany(
      { userId: user._id, kind: "reset", usedAt: null },
      { $set: { usedAt: new Date() } },
      { session },
    );
    await Session.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await Device.deleteMany({ userId: user._id }, { session });
    await Job.create([{ kind: "revoke", resourceId: user._id }], {
      session,
      ordered: true,
    });
    return true;
  });
  check(valid, 400, "INVALID_CODE", "Code is invalid or expired.");
  audit("password_reset", user._id);
}
export async function rotate(refreshToken: string) {
  const claims = await verifyRefresh(refreshToken);
  const tokens = await issue(
    claims.userId,
    claims.sessionId,
    undefined,
    claims.expiresAt,
  );
  const result = await transaction(async (session) => {
    const row = await Session.findById(claims.sessionId)
      .select("+digest")
      .session(session);
    if (
      !row ||
      row.userId !== claims.userId ||
      row.revokedAt ||
      row.expiresAt < new Date()
    )
      return "invalid";
    if (!equal(row.digest, digest(refreshToken))) {
      row.revokedAt = new Date();
      await row.save({ session });
      await Device.deleteMany({ sessionId: row.id }, { session });
      await Job.create(
        [{ kind: "revoke", resourceId: row.id, userId: row.userId }],
        { session, ordered: true },
      );
      return "replay";
    }
    const active = await User.exists({
      _id: claims.userId,
      status: "active",
      verified: true,
    }).session(session);
    if (!active) return "invalid";
    row.digest = digest(tokens.refreshToken);
    await row.save({ session });
    return "ok";
  });
  check(
    result === "ok",
    401,
    result === "replay" ? "REFRESH_REUSE" : "SESSION_EXPIRED",
    "Session expired. Please sign in again.",
  );
  return tokens;
}
export async function revoke(userId: string, sessionId?: string) {
  await transaction(async (session) => {
    await Session.updateMany(
      { userId, ...(sessionId ? { _id: sessionId } : {}) },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await Device.deleteMany(
      { userId, ...(sessionId ? { sessionId } : {}) },
      { session },
    );
    await Job.create(
      [
        {
          kind: "revoke",
          resourceId: sessionId || userId,
          ...(sessionId ? { userId } : {}),
        },
      ],
      { session, ordered: true },
    );
  });
  audit("session_revoked", userId, sessionId);
}
