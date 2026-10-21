import mongoose, { Schema } from "mongoose";
import { base, options } from "../../database/schema.js";
export const Report = mongoose.model(
  "Report",
  new Schema(
    {
      ...base,
      reporterId: { type: String, required: true },
      targetId: { type: String, required: true },
      reason: { type: String, required: true, maxlength: 1000 },
      expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 },
      },
    },
    options,
  ),
);
