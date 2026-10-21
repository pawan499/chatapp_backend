import mongoose from "mongoose";
import { connectDatabase } from "./connection.js";
import { models } from "./models.js";
await connectDatabase();
for (const model of models) await model.createIndexes();
await mongoose.disconnect();
console.log("Declared indexes created; existing indexes were not dropped.");
