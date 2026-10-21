import mongoose from "mongoose";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const port = Number(process.env.DEV_MONGO_PORT || 27018);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("DEV_MONGO_PORT must be 1024–65535.");
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", () =>
    reject(
      new Error(
        `Port ${port} is already in use. This command will not change an existing MongoDB server.`,
      ),
    ),
  );
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise((resolve) => probe.close(resolve));
const dir = resolve(process.env.DEV_MONGO_DIR || ".data/mongo");
await mkdir(dir, { recursive: true, mode: 0o700 });
const mongo = spawn(
  process.env.MONGOD_BINARY || "mongod",
  [
    "--dbpath",
    dir,
    "--replSet",
    "rs0",
    "--bind_ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--logpath",
    resolve(dir, "server.log"),
    "--logappend",
  ],
  { stdio: "ignore" },
);
let closed = false,
  stopping = false;
const exited = new Promise((resolve, reject) => {
  mongo.once("error", reject);
  mongo.once("exit", (code) => {
    closed = true;
    resolve(code);
  });
});
exited.catch(() => {});
async function stop() {
  if (stopping) return;
  stopping = true;
  await mongoose.disconnect().catch(() => {});
  if (!closed) mongo.kill("SIGTERM");
  const code = await exited;
  process.exit(code === 0 ? 0 : 1);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  let connected = false;
  for (let i = 0; i < 30; i++) {
    if (closed)
      throw new Error(
        "mongod exited. Check the private server.log in DEV_MONGO_DIR.",
      );
    try {
      await mongoose.connect(
        `mongodb://127.0.0.1:${port}/admin?directConnection=true`,
        { serverSelectionTimeoutMS: 500, autoIndex: false, maxPoolSize: 1 },
      );
      connected = true;
      break;
    } catch {
      await delay(100);
    }
  }
  if (!connected)
    throw new Error(
      "Could not start mongod. Install MongoDB 8 or set MONGOD_BINARY.",
    );
  const admin = mongoose.connection.db.admin();
  try {
    await admin.command({ replSetGetStatus: 1 });
  } catch (error) {
    if (error.code !== 94) throw error;
    await admin.command({
      replSetInitiate: {
        _id: "rs0",
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
  }
  let primary = false;
  for (let i = 0; i < 150; i++) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) {
      primary = true;
      break;
    }
    await delay(100);
  }
  if (!primary) throw new Error("Replica set did not elect a primary.");
  await mongoose.disconnect();
  console.log(
    `Development MongoDB replica set ready on 127.0.0.1:${port}. Keep this terminal running; Ctrl+C stops only this child process.`,
  );
  const code = await exited;
  if (!stopping) process.exit(code === 0 ? 0 : 1);
} catch (error) {
  console.error(error.message);
  if (!closed) mongo.kill("SIGTERM");
  await exited.catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
}
