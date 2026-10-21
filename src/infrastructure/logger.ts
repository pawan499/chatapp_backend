import pino from "pino";
import { env } from "../config/env.js";
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "password",
      "accessToken",
      "refreshToken",
      "token",
      "code",
      "authorization",
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
    ],
    remove: true,
  },
});
export function audit(event: string, actor: string, target?: string) {
  logger.info({ event, actor, target }, "security_audit");
}
