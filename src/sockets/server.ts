import { setTyping } from "../infrastructure/typing.js";
import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { z } from "zod";
import { origins } from "../config/env.js";
import { redis } from "../infrastructure/redis.js";
import { authenticate } from "../modules/auth/tokens.js";
import { consume } from "../infrastructure/rateLimit.js";
import { touchPresence, removePresence } from "../infrastructure/presence.js";
import { User, Membership, Block } from "../database/models.js";
import { send, receipt, mutate } from "../modules/messages/service.js";
import { member } from "../modules/conversations/authorization.js";
import { sendSchema, reactions } from "../modules/messages/validation.js";
import { id } from "../utils/pagination.js";
import { AppError, check } from "../utils/errors.js";
import { logger } from "../infrastructure/logger.js";
import type { Auth } from "../types/index.js";
export async function attachSockets(server: HttpServer) {
  let draining = false;
  const io = new Server(server, {
    maxHttpBufferSize: 32 * 1024,
    transports: ["websocket"],
    cors: { origin: origins, credentials: false },
    allowRequest: (req, cb) =>
      cb(null, !req.headers.origin || origins.includes(req.headers.origin)),
  });
  let pub: typeof redis, sub: typeof redis;
  if (redis) {
    pub = redis.duplicate();
    sub = redis.duplicate();
    pub.on("error", () =>
      logger.error("Socket Redis publish connection failed"),
    );
    sub.on("error", () =>
      logger.error("Socket Redis subscribe connection failed"),
    );
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
  }
  io.use(async (socket, next) => {
    try {
      check(
        !draining,
        503,
        "SHUTTING_DOWN",
        "Server is restarting. Please reconnect.",
      );
      await consume("socket-connect", socket.handshake.address, 30, 60);
      const token = z
        .string()
        .min(1)
        .max(4096)
        .parse(socket.handshake.auth.token);
      const auth = await authenticate(token);
      check(
        (await io.in(`user:${auth.userId}`).fetchSockets()).length < 10,
        429,
        "SOCKET_LIMIT",
        "Too many connected devices.",
      );
      socket.data.auth = auth;
      socket.data.token = token;
      next();
    } catch (e) {
      const error = new Error("Authentication failed.") as Error & {
        data: unknown;
      };
      error.data = { code: e instanceof AppError ? e.code : "SESSION_EXPIRED" };
      next(error);
    }
  });
  io.on("connection", (socket) => {
    const auth = socket.data.auth as Auth;
    socket.join([`user:${auth.userId}`, `session:${auth.sessionId}`]);
    let stopped = false;
    let expiry: ReturnType<typeof setTimeout>;
    const notifyPresence = async () => {
      const user = await User.findById(auth.userId)
        .select("preferences")
        .lean();
      if (user?.preferences.lastSeen) {
        const rows = await Membership.find({ userId: auth.userId })
          .select("conversationId")
          .limit(500)
          .lean();
        const peers = await Membership.find({
          conversationId: { $in: rows.map((m) => m.conversationId) },
          userId: { $ne: auth.userId },
        }).distinct("userId");
        const blocked = await Block.find({
          $or: [{ ownerId: auth.userId }, { targetId: auth.userId }],
        })
          .limit(1000)
          .lean();
        const excluded = new Set(
          blocked.map((b) =>
            b.ownerId === auth.userId ? b.targetId : b.ownerId,
          ),
        );
        for (const peer of peers)
          if (!excluded.has(peer))
            io.to(`user:${peer}`).emit("presence:updated");
      }
    };
    const pulse = async () => {
      try {
        await authenticate(socket.data.token);
        await touchPresence(auth.userId, socket.id);
      } catch (error) {
        if (error instanceof AppError && error.status === 401) {
          socket.emit("session:expired", { code: "SESSION_EXPIRED" });
          socket.disconnect(true);
        } else
          logger.warn(
            { event: "heartbeat_dependency_unavailable" },
            "Socket heartbeat will retry",
          );
      }
    };
    pulse()
      .then(() => notifyPresence())
      .catch(() => {});
    const heartbeat = setInterval(() => {
      pulse().catch(() => {});
    }, 30000);
    heartbeat.unref();
    expiry = setTimeout(
      () => {
        socket.emit("session:expired", { code: "SESSION_EXPIRED" });
        socket.disconnect(true);
      },
      Math.max(1, auth.expiresAt * 1000 - Date.now()),
    );
    expiry.unref();
    function event<T>(
      name: string,
      schema: z.ZodType<T>,
      limit: number,
      handler: (data: T) => Promise<unknown>,
    ) {
      socket.on(name, async (payload: unknown, ack?: unknown) => {
        const respond =
          typeof ack === "function"
            ? (ack as (data: unknown) => void)
            : () => {};
        try {
          check(
            !draining,
            503,
            "SHUTTING_DOWN",
            "Server is restarting. Please retry.",
          );
          check(!stopped, 401, "SESSION_EXPIRED", "Session expired.");
          await authenticate(socket.data.token);
          await consume(`socket-${name}`, auth.userId, limit, 60);
          check(
            !draining,
            503,
            "SHUTTING_DOWN",
            "Server is restarting. Please retry.",
          );
          const result = await handler(schema.parse(payload));
          respond(result ?? { ok: true });
        } catch (e) {
          respond({
            error:
              e instanceof AppError
                ? e.message
                : e instanceof z.ZodError
                  ? "Invalid event payload."
                  : "Unable to process event.",
            code:
              e instanceof AppError
                ? e.code
                : e instanceof z.ZodError
                  ? "VALIDATION_ERROR"
                  : "INTERNAL_ERROR",
          });
        }
      });
    }
    event("message:send", sendSchema, 60, async (data) => ({
      message: await send(auth, data),
    }));
    event(
      "conversation:join",
      z.object({ conversationId: id }).strict(),
      60,
      async (data) => {
        await member(auth.userId, data.conversationId);
        await socket.join(`conversation:${data.conversationId}`);
        return { ok: true };
      },
    );
    event(
      "conversation:leave",
      z.object({ conversationId: id }).strict(),
      60,
      async (data) => {
        await member(auth.userId, data.conversationId);
        await socket.leave(`conversation:${data.conversationId}`);
        return { ok: true };
      },
    );
    for (const kind of ["read", "delivered"] as const)
      event(
        `message:${kind}`,
        z.object({ conversationId: id, messageId: id }).strict(),
        120,
        async (data) => {
          await receipt(auth, data.conversationId, data.messageId, kind);
          return { ok: true };
        },
      );
    event(
      "message:edit",
      z
        .object({ messageId: id, text: z.string().trim().min(1).max(10000) })
        .strict(),
      60,
      async (data) => ({
        message: await mutate(auth, data.messageId, "edit", data.text),
      }),
    );
    event(
      "message:delete",
      z.object({ messageId: id }).strict(),
      60,
      async (data) => ({
        message: await mutate(auth, data.messageId, "delete"),
      }),
    );
    event(
      "message:reaction",
      z.object({ messageId: id, emoji: z.enum(reactions) }).strict(),
      60,
      async (data) => ({
        message: await mutate(auth, data.messageId, "reaction", data.emoji),
      }),
    );
    event(
      "typing:set",
      z.object({ conversationId: id, active: z.boolean() }).strict(),
      120,
      async (data) => {
        const { conversation } = await member(auth.userId, data.conversationId);
        const memberships = await Membership.find({
          conversationId: data.conversationId,
          userId: { $ne: auth.userId },
        })
          .select("userId")
          .limit(256)
          .lean();
        const blocked = await Block.find({
          $or: [
            {
              ownerId: auth.userId,
              targetId: { $in: memberships.map((m) => m.userId) },
            },
            {
              targetId: auth.userId,
              ownerId: { $in: memberships.map((m) => m.userId) },
            },
          ],
        }).lean();
        if (conversation.kind === "direct")
          check(
            blocked.length === 0,
            403,
            "BLOCKED",
            "This conversation is blocked.",
          );
        const typers = await setTyping(
          data.conversationId,
          auth.userId,
          data.active,
        );
        const currentMembers = new Set(memberships.map((m) => m.userId));
        currentMembers.add(auth.userId);
        for (const target of currentMembers)
          io.to(`user:${target}`).emit("typing:updated", {
            conversationId: data.conversationId,
            userNames: typers
              .filter((u) => u._id !== target && currentMembers.has(u._id))
              .map((u) => u.name),
          });
        return { ok: true };
      },
    );
    event(
      "sync:request",
      z
        .object({
          conversationId: id,
          afterSeq: z.number().int().nonnegative().default(0),
        })
        .strict(),
      30,
      async (data) => {
        await member(auth.userId, data.conversationId);
        const { Message } = await import("../database/models.js");
        const { serializeMessages } =
          await import("../modules/messages/serializer.js");
        const rows = await Message.find({
          conversationId: data.conversationId,
          seq: { $gt: data.afterSeq },
        })
          .sort({ seq: 1 })
          .limit(101)
          .lean();
        const items = rows.slice(0, 100);
        return {
          items: await serializeMessages(
            items.map((m) => m._id),
            auth.userId,
            auth.sessionId,
          ),
          nextAfterSeq: rows.length > 100 ? items.at(-1)!.seq : null,
        };
      },
    );
    socket.on("disconnect", () => {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      removePresence(auth.userId, socket.id)
        .then(() =>
          User.updateOne(
            { _id: auth.userId, status: "active" },
            { $max: { lastSeen: new Date() } },
          ),
        )
        .then(() => notifyPresence())
        .catch(() => {});
    });
  });
  return {
    io,
    beginShutdown() {
      draining = true;
    },
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all([pub?.quit(), sub?.quit()]);
    },
  };
}
