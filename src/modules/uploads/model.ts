import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface UploadDoc {
  _id: string;
  ownerId: string;
  sessionId: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  state: "pending" | "ready" | "deleting";
  conversationId?: string;
  avatarUserId?: string;
  avatarConversationId?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
const upload = new Schema<UploadDoc>(
  {
    ...base,
    ownerId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    state: {
      type: String,
      enum: ["pending", "ready", "deleting"],
      default: "pending",
    },
    conversationId: String,
    avatarUserId: String,
    avatarConversationId: String,
    expiresAt: { type: Date, required: true },
  },
  options,
);
upload.index({ expiresAt: 1, state: 1 });
upload.index({ conversationId: 1, createdAt: -1, _id: -1 });
export const Upload = mongoose.model<UploadDoc>("Upload", upload);
