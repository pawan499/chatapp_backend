import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export interface BlockDoc {
  _id: string;
  ownerId: string;
  targetId: string;
  createdAt: Date;
  updatedAt: Date;
}
const block = new Schema<BlockDoc>(
  {
    ...base,
    ownerId: { type: String, required: true },
    targetId: { type: String, required: true },
  },
  options,
);
block.index({ ownerId: 1, targetId: 1 }, { unique: true });
block.index({ targetId: 1, ownerId: 1 });
export const Block = mongoose.model<BlockDoc>("Block", block);
