import type { Request, Response } from "express";

import { pipeline } from "node:stream/promises";

import { param } from "../../middleware/validate.js";

import { check } from "../../utils/errors.js";
import { storage } from "../../infrastructure/storage.js";

import * as service from "./service.js";
export const create = async (req: Request, res: Response) => {
  check(req.file, 400, "MISSING_FILE", "Select a file to upload.");
  res
    .status(201)
    .json(
      await service.multipartUpload(
        req.auth,
        req.file.originalname,
        req.file.buffer,
      ),
    );
};
export const createInit = async (req: Request, res: Response) =>
  res.status(201).json(await service.initUpload(req.auth, req.body));
export const createByIdComplete = async (req: Request, res: Response) =>
  res.json(await service.completeUpload(req.auth, param(req)));
export const streamMedia = async (req: Request, res: Response) => {
  const row = await service.authorizeMedia(param(req), req.query);
  let range: undefined | { start: number; end: number };
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    check(match, 416, "RANGE", "Unsupported byte range.");
    const start = Number(match[1]),
      end = match[2] ? Number(match[2]) : row.size - 1;
    check(
      Number.isSafeInteger(start) &&
        start >= 0 &&
        end >= start &&
        end < row.size,
      416,
      "RANGE",
      "Invalid byte range.",
    );
    range = { start, end };
  }
  const result = await storage.get(row.key, range);
  res.status(range ? 206 : 200).set({
    "Content-Type": row.mime,
    "Content-Length": String(result.length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    ...(range
      ? { "Content-Range": `bytes ${range.start}-${range.end}/${row.size}` }
      : {}),
  });
  await pipeline(result.stream, res);
};
