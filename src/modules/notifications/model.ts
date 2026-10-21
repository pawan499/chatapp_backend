import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface DeviceDoc {
  _id: string;
  userId: string;
  sessionId: string;
  tokenHash: string;
  encryptedToken: string;
  platform: string;
  createdAt: Date;
  updatedAt: Date;
}
const device = new Schema<DeviceDoc>(
  {
    ...base,
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    encryptedToken: { type: String, required: true, select: false },
    platform: { type: String, enum: ["android", "ios"], required: true },
  },
  options,
);
export const Device = mongoose.model<DeviceDoc>("Device", device);
