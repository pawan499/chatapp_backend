import { findContacts } from "./repository.js";
import type { Request, Response } from "express";

import { z } from "zod";
import { User, Block, Report, Device } from "../../database/models.js";

import { param } from "../../middleware/validate.js";

import { listQuery, id, page, decodeCursor } from "../../utils/pagination.js";
import { check } from "../../utils/errors.js";
import { serializeUsers } from "./serializer.js";
import * as service from "./service.js";

export const getMe = async (req: Request, res: Response) =>
  res.json(
    (
      await serializeUsers(
        [req.auth.userId],
        req.auth.userId,
        req.auth.sessionId,
      )
    )[0],
  );
export const updateMe = async (req: Request, res: Response) =>
  res.json(await service.profile(req.auth, req.body));
export const deleteMe = async (req: Request, res: Response) => {
  await service.deleteAccount(req.auth, req.body.password);
  res.status(202).json({
    message:
      "Account access is revoked. Membership and unreferenced-media cleanup is queued.",
  });
};
export const getMePreferences = async (req: Request, res: Response) =>
  res.json((await User.findById(req.auth.userId).lean())!.preferences);
export const updateMePreferences = async (req: Request, res: Response) =>
  res.json(await service.updatePreferences(req.auth, req.body));
export const getUsersById = async (req: Request, res: Response) => {
  const rows = await serializeUsers(
    [param(req)],
    req.auth.userId,
    req.auth.sessionId,
  );
  check(rows.length, 404, "NOT_FOUND", "Contact not found.");
  res.json(rows[0]);
};
export const getContacts = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query),
    cursor = decodeCursor(q.cursor, z.object({ id, name: z.string() }));
  const rows = await findContacts(req.auth.userId, q.search, q.limit, cursor);
  const result = page(rows, q.limit, (u) => ({ id: u._id, name: u.name }));
  const users = await serializeUsers(
    result.items.map((u) => u._id),
    req.auth.userId,
    req.auth.sessionId,
  );
  const map = new Map(users.map((u) => [u.id, u]));
  res.json({ ...result, items: result.items.map((u) => map.get(u._id)) });
};
export const getMeBlocked = async (req: Request, res: Response) => {
  const rows = await Block.find({ ownerId: req.auth.userId })
    .sort({ _id: 1 })
    .limit(500)
    .lean();
  res.json(
    await serializeUsers(
      rows.map((b) => b.targetId),
      req.auth.userId,
      req.auth.sessionId,
    ),
  );
};
export const setMeBlockedById = async (req: Request, res: Response) => {
  await service.setBlock(req.auth, param(req), req.body.blocked);
  res.sendStatus(204);
};
export const createReports = async (req: Request, res: Response) => {
  check(
    req.body.userId !== req.auth.userId &&
      (await User.exists({ _id: req.body.userId })),
    400,
    "INVALID_CONTACT",
    "Invalid report target.",
  );
  await Report.create({
    reporterId: req.auth.userId,
    targetId: req.body.userId,
    reason: req.body.reason,
    expiresAt: new Date(Date.now() + 180 * 864e5),
  });
  res.sendStatus(204);
};
export const setMeDevices = async (req: Request, res: Response) => {
  await service.registerDevice(req.auth, req.body.token, req.body.platform);
  res.sendStatus(204);
};
export const getMeDevices = async (req: Request, res: Response) => {
  const rows = await Device.find({ userId: req.auth.userId })
    .select("_id platform createdAt sessionId")
    .limit(20)
    .lean();
  res.json({
    items: rows.map((d) => ({
      id: d._id,
      platform: d.platform,
      current: d.sessionId === req.auth.sessionId,
      createdAt: d.createdAt,
    })),
    nextCursor: null,
  });
};
export const deleteMeDevicesById = async (req: Request, res: Response) => {
  await Device.deleteOne({ _id: param(req), userId: req.auth.userId });
  res.sendStatus(204);
};
