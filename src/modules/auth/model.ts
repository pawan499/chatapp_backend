import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface SessionDoc {
  _id: string;
  userId: string;
  digest: string;
  expiresAt: Date;
  revokedAt?: Date;
  deviceName: string;
  createdAt: Date;
  updatedAt: Date;
}
const session = new Schema<SessionDoc>(
  {
    ...base,
    userId: { type: String, required: true, index: true },
    digest: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    deviceName: { type: String, default: "Mobile device" },
  },
  options,
);
session.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = mongoose.model<SessionDoc>("Session", session);
export interface ChallengeDoc {
  _id: string;
  userId: string;
  kind: "verify" | "reset";
  digest: string;
  attempts: number;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
const challenge = new Schema<ChallengeDoc>(
  {
    ...base,
    userId: { type: String, required: true },
    kind: { type: String, enum: ["verify", "reset"], required: true },
    digest: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
  },
  options,
);
challenge.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
challenge.index({ userId: 1, kind: 1, createdAt: -1 });
export const Challenge = mongoose.model<ChallengeDoc>("Challenge", challenge);
