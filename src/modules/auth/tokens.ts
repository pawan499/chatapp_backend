import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { Session, User } from "../../database/models.js";
import { check, AppError } from "../../utils/errors.js";
import type { Auth } from "../../types/index.js";
const key = (s: string) => new TextEncoder().encode(s);
const issuer = "luma-chat-api";
export async function issue(
  userId: string,
  sessionId: string,
  refreshId = randomUUID(),
  refreshExpiresAt?: number,
) {
  const accessToken = await new SignJWT({ sid: sessionId, kind: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience("luma-mobile")
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TTL_SECONDS}s`)
    .sign(key(env.ACCESS_TOKEN_SECRET));
  const refreshToken = await new SignJWT({ sid: sessionId, kind: "refresh" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setJti(refreshId)
    .setIssuer(issuer)
    .setAudience("luma-refresh")
    .setIssuedAt()
    .setExpirationTime(
      refreshExpiresAt ??
        Math.floor(Date.now() / 1000) + env.REFRESH_TTL_DAYS * 86400,
    )
    .sign(key(env.REFRESH_TOKEN_SECRET));
  return { accessToken, refreshToken, expiresIn: env.ACCESS_TTL_SECONDS };
}
export async function verifyRefresh(token: string) {
  try {
    const { payload: p } = await jwtVerify(
      token,
      key(env.REFRESH_TOKEN_SECRET),
      { algorithms: ["HS256"], issuer, audience: "luma-refresh" },
    );
    check(
      p.kind === "refresh" &&
        typeof p.sub === "string" &&
        typeof p.sid === "string" &&
        typeof p.jti === "string" &&
        typeof p.exp === "number",
      401,
      "INVALID_SESSION",
      "Session expired. Please sign in again.",
    );
    return { userId: p.sub, sessionId: p.sid, expiresAt: p.exp };
  } catch {
    check(
      false,
      401,
      "INVALID_SESSION",
      "Session expired. Please sign in again.",
    );
  }
}
export async function authenticate(token: string): Promise<Auth> {
  let claims: Auth;
  try {
    const { payload: p } = await jwtVerify(
      token,
      key(env.ACCESS_TOKEN_SECRET),
      { algorithms: ["HS256"], issuer, audience: "luma-mobile" },
    );
    check(
      p.kind === "access" &&
        typeof p.sub === "string" &&
        typeof p.sid === "string" &&
        typeof p.exp === "number",
      401,
      "SESSION_EXPIRED",
      "Session expired. Please sign in again.",
    );
    claims = { userId: p.sub, sessionId: p.sid, expiresAt: p.exp };
  } catch {
    throw new AppError(
      401,
      "SESSION_EXPIRED",
      "Session expired. Please sign in again.",
    );
  }
  let active: boolean;
  try {
    const [session, user] = await Promise.all([
      Session.exists({
        _id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
      User.exists({ _id: claims.userId, status: "active", verified: true }),
    ]);
    active = !!session && !!user;
  } catch {
    throw new AppError(
      503,
      "DATABASE_UNAVAILABLE",
      "The service is temporarily unavailable. Please retry.",
    );
  }
  check(
    active,
    401,
    "SESSION_EXPIRED",
    "Session expired. Please sign in again.",
  );
  return claims;
}
