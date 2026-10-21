import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface MessageDoc {
  _id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  requestHash: string;
  recipientIds: string[];
  seq: number;
  text: string;
  attachmentIds: string[];
  replyToId?: string;
  version: number;
  edited: boolean;
  deleted: boolean;
  links: string[];
  createdAt: Date;
  updatedAt: Date;
}
const message = new Schema<MessageDoc>(
  {
    ...base,
    conversationId: { type: String, required: true },
    senderId: { type: String, required: true },
    clientId: { type: String, required: true },
    requestHash: { type: String, required: true },
    recipientIds: { type: [String], required: true },
    seq: { type: Number, required: true },
    text: { type: String, default: "", maxlength: 10000 },
    attachmentIds: { type: [String], default: [] },
    replyToId: String,
    version: { type: Number, default: 1 },
    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    links: { type: [String], default: [] },
  },
  options,
);
message.index({ senderId: 1, clientId: 1 }, { unique: true });
message.index({ conversationId: 1, seq: -1 }, { unique: true });
message.index({ conversationId: 1, deleted: 1, seq: 1, senderId: 1 });
message.index({ conversationId: 1, text: "text" });
export const Message = mongoose.model<MessageDoc>("Message", message);
export interface ReactionDoc {
  _id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
  updatedAt: Date;
}
const reaction = new Schema<ReactionDoc>(
  {
    ...base,
    messageId: { type: String, required: true },
    userId: { type: String, required: true },
    emoji: { type: String, required: true },
  },
  options,
);
reaction.index({ messageId: 1, userId: 1 }, { unique: true });
export const Reaction = mongoose.model<ReactionDoc>("Reaction", reaction);
export interface ReceiptDoc {
  _id: string;
  conversationId: string;
  userId: string;
  readSeq: number;
  deliveredSeq: number;
}
const receipt = new Schema<ReceiptDoc>(
  {
    ...base,
    conversationId: { type: String, required: true },
    userId: { type: String, required: true },
    readSeq: { type: Number, default: 0 },
    deliveredSeq: { type: Number, default: 0 },
  },
  options,
);
receipt.index({ conversationId: 1, userId: 1 }, { unique: true });
export const Receipt = mongoose.model<ReceiptDoc>("Receipt", receipt);
