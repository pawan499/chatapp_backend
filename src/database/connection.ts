import mongoose from "mongoose";
import { env } from "../config/env.js";
import { check } from "../utils/errors.js";
export async function connectDatabase() {
  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: false,
    maxPoolSize: 30,
    serverSelectionTimeoutMS: 10000,
  });
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  check(
    hello.setName || hello.msg === "isdbgrid",
    503,
    "REPLICA_SET_REQUIRED",
    "MongoDB must be a replica set or sharded cluster for transactions.",
  );
}
export async function transaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  return mongoose.connection.transaction(fn, {
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
}
