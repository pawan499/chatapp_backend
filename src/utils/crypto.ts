import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { env } from "../config/env.js";
export const digest = (s: string) =>
  createHmac("sha256", env.TOKEN_PEPPER).update(s).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(env.DEVICE_ENCRYPTION_KEY, "hex"),
      iv,
    );
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function decrypt(value: string) {
  const b = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(env.DEVICE_ENCRYPTION_KEY, "hex"),
      b.subarray(0, 12),
    );
  cipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([
    cipher.update(b.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
