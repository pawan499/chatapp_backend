import type { RequestHandler, Request } from "express";
import { z } from "zod";
import { id } from "../utils/pagination.js";
export const validate =
  (schema: z.ZodType): RequestHandler =>
  (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      next(e);
    }
  };
export function param(req: Request, name = "id") {
  return id.parse(req.params[name]);
}
