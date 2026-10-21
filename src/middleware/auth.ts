import type { RequestHandler } from "express";
import { authenticate } from "../modules/auth/tokens.js";
import { check } from "../utils/errors.js";
export const auth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    check(
      typeof header === "string" && header.startsWith("Bearer "),
      401,
      "UNAUTHENTICATED",
      "Sign in to continue.",
    );
    req.auth = await authenticate(header.slice(7));
    next();
  } catch (e) {
    next(e);
  }
};
