import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface ConversationDoc {
  _id: string;
  kind: "direct" | "group";
  directKey?: string;
  name: string;
  description: string;
  avatarId?: string;
  seq: number;
  revision: number;
  memberCount: number;
  adminCount: number;
  lastMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}
const conversation = new Schema<ConversationDoc>(
  {
    ...base,
    kind: { type: String, enum: ["direct", "group"], required: true },
    directKey: String,
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    avatarId: String,
    seq: { type: Number, default: 0 },
    revision: { type: Number, default: 0 },
    memberCount: { type: Number, required: true },
    adminCount: { type: Number, required: true },
    lastMessageId: String,
  },
  options,
);
conversation.index({ memberCount: 1, updatedAt: 1 });
conversation.index(
  { directKey: 1 },
  { unique: true, partialFilterExpression: { directKey: { $type: "string" } } },
);
export const Conversation = mongoose.model<ConversationDoc>(
  "Conversation",
  conversation,
);
export interface MembershipDoc {
  _id: string;
  userId: string;
  conversationId: string;
  role: "admin" | "member";
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  readSeq: number;
  deliveredSeq: number;
  activityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
const membership = new Schema<MembershipDoc>(
  {
    ...base,
    userId: { type: String, required: true },
    conversationId: { type: String, required: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    pinned: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    readSeq: { type: Number, default: 0 },
    deliveredSeq: { type: Number, default: 0 },
    activityAt: { type: Date, default: Date.now },
  },
  options,
);
membership.index({ userId: 1, conversationId: 1 }, { unique: true });
membership.index({ userId: 1, pinned: -1, activityAt: -1, conversationId: -1 });
membership.index({ conversationId: 1, userId: 1 });
export const Membership = mongoose.model<MembershipDoc>(
  "Membership",
  membership,
);
