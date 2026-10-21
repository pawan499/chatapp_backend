import mongoose, { Schema } from "mongoose";
import { base, options } from "../database/schema.js";
export interface JobDoc {
  _id: string;
  kind:
    | "message"
    | "conversation"
    | "revoke"
    | "push"
    | "notify"
    | "membership"
    | "receipt"
    | "account_cleanup"
    | "membership"
    | "receipt"
    | "mail";
  secret?: string;
  fromSeq?: number;
  toSeq?: number;
  resourceId: string;
  userId?: string;
  attempts: number;
  availableAt: Date;
  leaseUntil: Date;
  doneAt?: Date;
  dead: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
const job = new Schema<JobDoc>(
  {
    ...base,
    kind: { type: String, required: true },
    resourceId: { type: String, required: true },
    secret: { type: String, select: false },
    userId: String,
    fromSeq: Number,
    toSeq: Number,
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: () => new Date(0) },
    doneAt: Date,
    dead: { type: Boolean, default: false },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 864e5) },
  },
  options,
);
job.index({ kind: 1, dead: 1, doneAt: 1, availableAt: 1, leaseUntil: 1 });
job.index({ doneAt: 1, dead: 1, availableAt: 1 });
job.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Job = mongoose.model<JobDoc>("Job", job);
