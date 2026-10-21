import { randomUUID } from "node:crypto";
export const base = { _id: { type: String, default: () => randomUUID() } };
export const options = { timestamps: true, strict: "throw" as const };
