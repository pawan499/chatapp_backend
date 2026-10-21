import type { Request, Response } from "express";

import { param } from "../../middleware/validate.js";

import { mutate } from "./service.js";

export const updateById = async (req: Request, res: Response) =>
  res.json(await mutate(req.auth, param(req), "edit", req.body.text));
export const deleteById = async (req: Request, res: Response) =>
  res.json(await mutate(req.auth, param(req), "delete"));
export const setByIdReaction = async (req: Request, res: Response) =>
  res.json(await mutate(req.auth, param(req), "reaction", req.body.emoji));
