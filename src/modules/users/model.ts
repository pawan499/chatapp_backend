import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  bio: string;
  avatarId?: string;
  verified: boolean;
  profileComplete: boolean;
  status: "active" | "deleted";
  preferences: {
    notifications: boolean;
    previews: boolean;
    readReceipts: boolean;
    lastSeen: boolean;
  };
  lastSeen?: Date;
  policyVersion: number;
  conversationCount: number;
  createdAt: Date;
  updatedAt: Date;
}
const user = new Schema<UserDoc>(
  {
    ...base,
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true, select: false },
    bio: { type: String, default: "" },
    avatarId: String,
    verified: { type: Boolean, default: false },
    profileComplete: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "deleted"], default: "active" },
    preferences: {
      notifications: { type: Boolean, default: true },
      previews: { type: Boolean, default: false },
      readReceipts: { type: Boolean, default: true },
      lastSeen: { type: Boolean, default: true },
    },
    lastSeen: Date,
    policyVersion: { type: Number, default: 0 },
    conversationCount: { type: Number, default: 0 },
  },
  options,
);
user.index({ name: 1, _id: 1 });
export const User = mongoose.model<UserDoc>("User", user);
