import { findHistory } from "../messages/repository.js";
import type { Request, Response } from "express";

import { z } from "zod";
import {
  Conversation,
  Membership,
  User,
  Message,
  Upload,
} from "../../database/models.js";

import { param } from "../../middleware/validate.js";
import {
  id,
  listQuery,
  page,
  decodeCursor,
  escapeRegex,
} from "../../utils/pagination.js";

import { serializeConversations } from "./serializer.js";
import { serializeMessages } from "../messages/serializer.js";
import { attachment } from "../uploads/service.js";
import { member } from "./authorization.js";
import { check } from "../../utils/errors.js";
import * as service from "./service.js";
import { membershipAction } from "../groups/service.js";
import { send } from "../messages/service.js";
import { sendSchema } from "../messages/validation.js";
export const create = async (req: Request, res: Response) =>
  res.status(201).json(await service.createConversation(req.auth, req.body));
export const list = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const cursor = decodeCursor(
    q.cursor,
    z.object({ pinned: z.boolean(), date: z.iso.datetime(), id }),
  );
  const conditions: object[] = [{ userId: req.auth.userId }];
  if (q.search) {
    const memberships = await Membership.find({ userId: req.auth.userId })
      .limit(500)
      .lean();
    const ids = memberships.map((m) => m.conversationId);
    const convs = await Conversation.find({ _id: { $in: ids } }).lean(),
      directIds = convs.filter((c) => c.kind === "direct").map((c) => c._id);
    const peers = await Membership.find({
      conversationId: { $in: directIds },
      userId: { $ne: req.auth.userId },
    })
      .limit(500)
      .lean();
    const users = await User.find({
      _id: { $in: peers.map((m) => m.userId) },
      name: { $regex: escapeRegex(q.search), $options: "i" },
    })
      .select("_id")
      .lean();
    const matched = new Set(users.map((u) => u._id));
    const cids = [
      ...convs
        .filter(
          (c) =>
            c.kind === "group" &&
            c.name.toLowerCase().includes(q.search.toLowerCase()),
        )
        .map((c) => c._id),
      ...peers
        .filter((m) => matched.has(m.userId))
        .map((m) => m.conversationId),
    ];
    conditions.push({ conversationId: { $in: cids } });
  }
  if (cursor)
    conditions.push({
      $or: [
        ...(cursor.pinned ? [{ pinned: false }] : []),
        { pinned: cursor.pinned, activityAt: { $lt: new Date(cursor.date) } },
        {
          pinned: cursor.pinned,
          activityAt: new Date(cursor.date),
          conversationId: { $lt: cursor.id },
        },
      ],
    });
  const rows = await Membership.find({ $and: conditions })
    .sort({ pinned: -1, activityAt: -1, conversationId: -1 })
    .limit(q.limit + 1)
    .lean();
  const result = page(rows, q.limit, (m) => ({
    pinned: m.pinned,
    date: m.activityAt.toISOString(),
    id: m.conversationId,
  }));
  res.json({
    ...result,
    items: await serializeConversations(
      result.items.map((m) => m.conversationId),
      req.auth.userId,
      req.auth.sessionId,
    ),
  });
};
export const getById = async (req: Request, res: Response) => {
  const cid = param(req);
  await member(req.auth.userId, cid);
  res.json(
    (
      await serializeConversations([cid], req.auth.userId, req.auth.sessionId)
    )[0],
  );
};
export const updateById = async (req: Request, res: Response) => {
  await service.updateConversation(req.auth, param(req), req.body);
  res.sendStatus(204);
};
export const createByIdMembers = async (req: Request, res: Response) => {
  await membershipAction(
    req.auth,
    param(req),
    req.body.userId,
    req.body.action,
  );
  res.sendStatus(204);
};
export const getByIdMessages = async (req: Request, res: Response) => {
  const cid = param(req);
  await member(req.auth.userId, cid);
  const q = listQuery.parse(req.query),
    cursor = decodeCursor(
      q.cursor,
      z.object({
        conversationId: id,
        seq: z.number().int().positive(),
        search: z.string(),
      }),
    );
  if (cursor)
    check(
      cursor.conversationId === cid && cursor.search === q.search,
      400,
      "INVALID_CURSOR",
      "Cursor belongs to another search or conversation.",
    );
  const rows = await findHistory(cid, q.limit, q.search, cursor?.seq);
  const result = page(rows, q.limit, (m) => ({
    conversationId: cid,
    seq: m.seq,
    search: q.search,
  }));
  res.json({
    ...result,
    items: await serializeMessages(
      result.items.map((m) => m._id),
      req.auth.userId,
      req.auth.sessionId,
    ),
  });
};
export const createByIdMessages = async (req: Request, res: Response) => {
  const data = sendSchema.parse({ ...req.body, conversationId: param(req) });
  res.status(201).json(await send(req.auth, data));
};
export const getByIdShared = async (req: Request, res: Response) => {
  const cid = param(req);
  await member(req.auth.userId, cid);
  const q = listQuery
      .extend({ type: z.enum(["media", "documents", "links"]) })
      .parse(req.query),
    cursor = decodeCursor(
      q.cursor,
      z.object({
        seq: z.number().int().positive(),
        conversationId: id,
        type: z.string(),
      }),
    );
  if (cursor)
    check(
      cursor.conversationId === cid && cursor.type === q.type,
      400,
      "INVALID_CURSOR",
      "Invalid shared-items cursor.",
    );
  const rows = await Message.find({
    conversationId: cid,
    deleted: false,
    ...(cursor ? { seq: { $lt: cursor.seq } } : {}),
    ...(q.type === "links"
      ? { "links.0": { $exists: true } }
      : { "attachmentIds.0": { $exists: true } }),
  })
    .sort({ seq: -1 })
    .limit(q.limit + 1)
    .lean();
  const result = page(rows, q.limit, (m) => ({
    seq: m.seq,
    conversationId: cid,
    type: q.type,
  }));
  if (q.type === "links") {
    res.json({
      ...result,
      items: result.items.flatMap((m) =>
        m.links.map((url, index) => ({
          id: `${m._id}-${index}`,
          url,
          name: url,
          mime: "text/uri-list",
          size: 0,
        })),
      ),
    });
    return;
  }
  const uploads = await Upload.find({
    _id: { $in: result.items.flatMap((m) => m.attachmentIds) },
    state: "ready",
  }).lean();
  const sorted = new Map(uploads.map((a) => [a._id, a]));
  res.json({
    ...result,
    items: [...new Set(result.items.flatMap((m) => m.attachmentIds))]
      .map((id) => sorted.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .filter((a) =>
        q.type === "media"
          ? /^(image|audio|video)\//.test(a.mime)
          : !/^(image|audio|video)\//.test(a.mime),
      )
      .map((a) => attachment(a, req.auth.sessionId)),
  });
};
