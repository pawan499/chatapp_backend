import { env } from "../config/env.js";
import type { Server } from "socket.io";
import { setTimeout as delay } from "node:timers/promises";

import {
  Job,
  Message,
  Membership,
  Session,
  User,
  Device,
  Conversation,
  Upload,
  type JobDoc,
  Challenge,
} from "../database/models.js";
import { transaction } from "../database/connection.js";
import { serializeMessages } from "../modules/messages/serializer.js";
import { deliverPush } from "../modules/notifications/provider.js";
import { storage } from "./storage.js";
import { logger } from "./logger.js";
import { sendCode } from "./mail.js";
import { decrypt } from "../utils/crypto.js";

async function publish(io: Server, ids: string[], cid: string) {
  const members = await Membership.find({ conversationId: cid })
    .select("userId")
    .limit(256)
    .lean();
  if (!members.length) return;
  const sockets = await io
    .in(members.map((m) => `user:${m.userId}`))
    .fetchSockets();
  const unique = new Map(
    sockets.map((s) => [
      s.data.auth.sessionId,
      s.data.auth as { userId: string; sessionId: string },
    ]),
  );
  for (const auth of unique.values()) {
    if (
      !(await Session.exists({
        _id: auth.sessionId,
        userId: auth.userId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })) ||
      !(await Membership.exists({ conversationId: cid, userId: auth.userId }))
    )
      continue;
    const messages = await serializeMessages(ids, auth.userId, auth.sessionId);
    for (const message of messages)
      io.to(`session:${auth.sessionId}`).emit("message:upsert", message);
  }
}
async function invalidation(io: Server, cid: string) {
  const rows = await Membership.find({ conversationId: cid })
    .select("userId")
    .limit(256)
    .lean();
  if (rows.length)
    io.to(rows.map((m) => `user:${m.userId}`)).emit("conversation:updated", {
      conversationId: cid,
    });
}
async function cleanupAccount(userId: string) {
  for await (const membership of Membership.find({ userId }).cursor({
    batchSize: 50,
  })) {
    await transaction(async (session) => {
      const current = await Membership.findById(membership.id).session(session);
      if (!current) return;
      const conversation = await Conversation.findByIdAndUpdate(
        current.conversationId,
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      );
      if (!conversation) return;
      if (current.role === "admin" && conversation.adminCount === 1) {
        const next = await Membership.findOne({
          conversationId: current.conversationId,
          userId: { $ne: userId },
        })
          .sort({ createdAt: 1 })
          .session(session);
        if (next) {
          next.role = "admin";
          await next.save({ session });
          conversation.adminCount++;
        }
      }
      await Membership.deleteOne({ _id: current.id }, { session });
      conversation.memberCount--;
      if (current.role === "admin") conversation.adminCount--;
      await conversation.save({ session });
      await Job.create(
        [
          { kind: "conversation", resourceId: conversation.id },
          { kind: "membership", resourceId: conversation.id, userId },
        ],
        { session, ordered: true },
      );
    });
  }
  await User.updateOne({ _id: userId }, { $set: { conversationCount: 0 } });
}
export async function handleJob(job: JobDoc, io?: Server) {
  if (job.kind === "mail") {
    const c = await Challenge.findOne({
      _id: job.resourceId,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (c && job.secret) {
      const u = await User.findOne({ _id: c.userId, status: "active" }).lean();
      if (u) await sendCode(u.email, decrypt(job.secret), c.kind);
    }
  } else if (job.kind === "message") {
    const row = await Message.findById(job.resourceId).lean();
    if (row && io) {
      await publish(io, [row._id], row.conversationId);
      await invalidation(io, row.conversationId);
    }
  } else if (job.kind === "conversation") {
    if (io) await invalidation(io, job.resourceId);
  } else if (job.kind === "membership") {
    if (io) {
      if (
        !(await Membership.exists({
          conversationId: job.resourceId,
          userId: job.userId,
        }))
      )
        await io
          .in(`user:${job.userId}`)
          .socketsLeave(`conversation:${job.resourceId}`);
      io.to(`user:${job.userId}`).emit("conversation:updated", {
        conversationId: job.resourceId,
      });
    }
  } else if (job.kind === "revoke") {
    if (io) {
      const room = job.userId
        ? `session:${job.resourceId}`
        : `user:${job.resourceId}`;
      io.to(room).emit("session:expired", { code: "SESSION_EXPIRED" });
      io.in(room).disconnectSockets(true);
    }
  } else if (job.kind === "receipt") {
    if (io) {
      const cursor = Message.find({
        conversationId: job.resourceId,
        seq: { $gt: job.fromSeq || 0, $lte: job.toSeq || 0 },
        senderId: { $ne: job.userId },
      })
        .sort({ seq: 1 })
        .cursor({ batchSize: 50 });
      let chunk: string[] = [];
      for await (const m of cursor) {
        chunk.push(m.id);
        if (chunk.length === 50) {
          await publish(io, chunk, job.resourceId);
          chunk = [];
        }
      }
      if (chunk.length) await publish(io, chunk, job.resourceId);
    }
  } else if (job.kind === "notify") {
    const m = await Message.findById(job.resourceId).lean();
    if (m && !m.deleted) {
      const recipients = await Membership.find({
        conversationId: m.conversationId,
        userId: { $ne: m.senderId },
        muted: false,
      })
        .select("userId")
        .limit(256)
        .lean();
      const devices = await Device.find({
        userId: { $in: recipients.map((r) => r.userId) },
      })
        .select("_id")
        .limit(5120)
        .lean();
      if (devices.length)
        await Job.insertMany(
          devices.map((d) => ({
            _id: `push:${m._id}:${d._id}`,
            kind: "push",
            resourceId: m._id,
            userId: d._id,
          })),
          { ordered: false },
        ).catch((e) => {
          if (
            e.code !== 11000 &&
            e.writeErrors?.some((w: { code: number }) => w.code !== 11000)
          )
            throw e;
        });
    }
  } else if (job.kind === "push") {
    await deliverPush(job.userId!, job.resourceId);
  } else if (job.kind === "account_cleanup")
    await cleanupAccount(job.resourceId);
}
export async function runOneJob(io?: Server) {
  const kinds: JobDoc["kind"][] = io
    ? [
        "message",
        "conversation",
        "membership",
        "receipt",
        "revoke",
        "notify",
        "push",
        "account_cleanup",
        "mail",
      ]
    : ["notify", "push", "account_cleanup", "mail"];
  const now = new Date(),
    lease = new Date(Date.now() + 60000);
  const job = await Job.findOneAndUpdate(
    {
      kind: { $in: kinds },
      doneAt: null,
      dead: false,
      availableAt: { $lte: now },
      leaseUntil: { $lte: now },
    },
    { $set: { leaseUntil: lease }, $inc: { attempts: 1 } },
    { sort: { availableAt: 1 }, returnDocument: "after" },
  )
    .select("+secret")
    .lean();
  if (!job) return false;
  const renew = setInterval(() => {
    Job.updateOne(
      { _id: job._id, doneAt: null },
      { $set: { leaseUntil: new Date(Date.now() + 60000) } },
    ).catch(() => {});
  }, 20000);
  renew.unref();
  try {
    await handleJob(job, io);
    await Job.updateOne(
      { _id: job._id },
      { $set: { doneAt: new Date() }, $unset: { secret: 1 } },
    );
  } catch (e) {
    logger.error(
      {
        jobId: job._id,
        kind: job.kind,
        attempts: job.attempts,
        errorType: e instanceof Error ? e.name : "unknown",
      },
      "Background job failed",
    );
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          leaseUntil: new Date(0),
          availableAt: new Date(
            Date.now() + Math.min(300000, 1000 * 2 ** job.attempts),
          ),
          dead: job.attempts >= 10,
        },
      },
    );
  } finally {
    clearInterval(renew);
  }
  return true;
}
let cleanupCursor: string | undefined;
export async function cleanupUploads() {
  const rows = await Upload.find({
    expiresAt: { $lt: new Date() },
    ...(cleanupCursor ? { _id: { $gt: cleanupCursor } } : {}),
  })
    .sort({ _id: 1 })
    .limit(100)
    .lean();
  cleanupCursor = rows.length === 100 ? rows.at(-1)!._id : undefined;
  for (const row of rows) {
    const remove = await transaction(async (session) => {
      const current = await Upload.findById(row._id).session(session);
      if (!current || current.expiresAt > new Date()) return false;
      if (
        (await Message.exists({
          attachmentIds: row._id,
          deleted: false,
        }).session(session)) ||
        (await User.exists({ avatarId: row._id, status: "active" }).session(
          session,
        )) ||
        (await Conversation.exists({
          avatarId: row._id,
          $or: [
            { memberCount: { $gt: 0 } },
            {
              updatedAt: {
                $gt: new Date(Date.now() - env.RETENTION_DAYS * 864e5),
              },
            },
          ],
        }).session(session))
      )
        return false;
      await Upload.updateOne(
        { _id: row._id },
        { $set: { state: "deleting" } },
        { session },
      );
      return true;
    });
    if (remove) {
      await storage.remove(row.key);
      await storage.remove(`private/${row.ownerId}/${row._id}`);
      await storage.remove(`quarantine/${row.ownerId}/${row._id}`);
      await Upload.deleteOne({ _id: row._id, state: "deleting" });
    }
  }
}
export function startJobs(io?: Server) {
  let stop = false;
  const loop = (async () => {
    let nextCleanup = Date.now() + 60000;
    while (!stop) {
      try {
        if (!(await runOneJob(io))) await delay(250);
        if (Date.now() > nextCleanup) {
          await cleanupEmptyConversations();
          await cleanupUploads();
          nextCleanup = Date.now() + 60000;
        }
      } catch {
        logger.error(
          { event: "job_poll_failure" },
          "Background worker temporarily unavailable",
        );
        await delay(1000);
      }
    }
  })();
  return async () => {
    stop = true;
    await loop;
  };
}

export async function cleanupEmptyConversations() {
  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 864e5);
  const rows = await Conversation.find({
    memberCount: 0,
    updatedAt: { $lt: cutoff },
  })
    .select("_id")
    .limit(10)
    .lean();
  for (const row of rows) {
    for (;;) {
      const messages = await Message.find({ conversationId: row._id })
        .select("_id")
        .limit(100)
        .lean();
      if (!messages.length) break;
      const ids = messages.map((m) => m._id);
      await transaction(async (session) => {
        await (
          await import("../modules/messages/model.js")
        ).Reaction.deleteMany({ messageId: { $in: ids } }, { session });
        await Message.deleteMany({ _id: { $in: ids } }, { session });
      });
    }
    await transaction(async (session) => {
      await (
        await import("../modules/messages/model.js")
      ).Receipt.deleteMany({ conversationId: row._id }, { session });
      await Conversation.deleteOne(
        { _id: row._id, memberCount: 0 },
        { session },
      );
    });
  }
}
