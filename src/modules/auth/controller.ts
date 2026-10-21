import type { Request, Response } from "express";

import * as service from "./service.js";

import { param } from "../../middleware/validate.js";

import { Session } from "../../database/models.js";
import { check } from "../../utils/errors.js";
import { logger } from "../../infrastructure/logger.js";
export const createRegister = async (req: Request, res: Response) =>
  res.status(201).json(await service.register(req.body));
export const createLogin = async (req: Request, res: Response) =>
  res.json(await service.login(req.body));
export const createVerify = async (req: Request, res: Response) =>
  res.json(await service.verifyAccount(req.body.challengeId, req.body.code));
export const createRefresh = async (req: Request, res: Response) =>
  res.json(await service.rotate(req.body.refreshToken));
export const createForgotPassword = async (req: Request, res: Response) => {
  try {
    await service.forgotPassword(req.body.email);
  } catch (e) {
    if ((e as { status?: number }).status === 429) throw e;
    logger.error(
      { event: "reset_mail_failed" },
      "Password reset request failed",
    );
  }
  res.sendStatus(204);
};
export const createResetPassword = async (req: Request, res: Response) => {
  await service.resetPassword(req.body.email, req.body.code, req.body.password);
  res.sendStatus(204);
};
export const createLogout = async (req: Request, res: Response) => {
  await service.revoke(req.auth.userId, req.auth.sessionId);
  res.sendStatus(204);
};
export const createLogoutAll = async (req: Request, res: Response) => {
  await service.revoke(req.auth.userId);
  res.sendStatus(204);
};
export const getSessions = async (req: Request, res: Response) => {
  const rows = await Session.find({
    userId: req.auth.userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({
    items: rows.map((s) => ({
      id: s._id,
      deviceName: s.deviceName,
      current: s._id === req.auth.sessionId,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    })),
    nextCursor: null,
  });
};
export const deleteSessionsById = async (req: Request, res: Response) => {
  const sid = param(req);
  check(
    await Session.exists({ _id: sid, userId: req.auth.userId }),
    404,
    "NOT_FOUND",
    "Session not found.",
  );
  await service.revoke(req.auth.userId, sid);
  res.sendStatus(204);
};
