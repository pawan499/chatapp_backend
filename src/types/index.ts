export type Auth = { userId: string; sessionId: string; expiresAt: number };
declare global {
  namespace Express {
    interface Request {
      auth: Auth;
      requestId: string;
    }
  }
}
