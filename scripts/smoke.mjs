import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const dir = await mkdtemp(join(tmpdir(), "luma-smoke-"));
let replica, server;
const children = new Set();
function launch(file, env) {
  const child = spawn(process.execPath, [file], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let errors = "";
  child.stderr.on("data", (b) => {
    errors = (errors + b).slice(-3000);
  });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${file} exited (${code ?? signal}); ${errors}`));
    });
  });
  done.catch(() => {});
  return { child, done };
}
try {
  const tcp = createServer();
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  const port = tcp.address().port;
  await new Promise((r) => tcp.close(r));
  replica = await MongoMemoryReplSet.create({
    binary: {
      systemBinary:
        process.env.MONGOMS_SYSTEM_BINARY ||
        (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined),
    },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    MONGODB_URI: replica.getUri("test_luma_smoke"),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    DATA_DIR: dir,
    STORAGE: "local",
    SCAN_MODE: "disabled",
    EMAIL_VERIFICATION: "false",
    INSTANCE_COUNT: "1",
    LOG_LEVEL: "silent",
    CORS_ORIGINS: "",
    TRUST_PROXY_HOPS: "0",
    DOTENV_CONFIG_PATH: join(dir, "empty.env"),
    DOTENV_CONFIG_QUIET: "true",
  };
  await writeFile(env.DOTENV_CONFIG_PATH, "", { mode: 0o600 });
  for (const key of [
    "ACCESS_TOKEN_SECRET",
    "REFRESH_TOKEN_SECRET",
    "TOKEN_PEPPER",
    "MEDIA_SIGNING_SECRET",
    "DEVICE_ENCRYPTION_KEY",
    "METRICS_TOKEN",
  ])
    env[key] = randomBytes(32).toString("hex");
  for (const key of [
    "REDIS_URL",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "FCM_PROJECT_ID",
    "FCM_CREDENTIALS_FILE",
    "S3_BUCKET",
    "S3_ENDPOINT",
  ])
    delete env[key];
  if (!new URL(env.MONGODB_URI).pathname.startsWith("/test_luma_"))
    throw new Error("Unsafe smoke database name");
  await launch("dist/database/indexes.js", env).done;
  server = launch("dist/server.js", env);
  const origin = env.PUBLIC_URL;
  let healthy = false;
  for (let n = 0; n < 200; n++) {
    try {
      if ((await fetch(origin + "/ready")).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await delay(50);
  }
  if (!healthy) throw new Error("Compiled server failed readiness");
  const api = async (path, method = "GET", body, token) => {
    const response = await fetch(origin + "/api/v1" + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(`${method} ${path} failed (${response.status})`);
    return response.status === 204 ? undefined : response.json();
  };
  const password = randomBytes(20).toString("hex");
  const a = await api("/auth/register", "POST", {
    name: "Smoke A",
    email: "smoke-a@test.invalid",
    password,
  });
  const b = await api("/auth/register", "POST", {
    name: "Smoke B",
    email: "smoke-b@test.invalid",
    password,
  });
  const chat = await api(
    "/conversations",
    "POST",
    { kind: "direct", userId: b.user.id },
    a.accessToken,
  );
  const sent = await api(
    `/conversations/${chat.id}/messages`,
    "POST",
    { clientId: "smoke-client-message", text: "Compiled integration smoke" },
    a.accessToken,
  );
  if (sent.status !== "sent") throw new Error("Unexpected delivery claim");
  const inbox = await api("/conversations", "GET", undefined, b.accessToken);
  if (inbox.items[0].unread !== 1) throw new Error("Unread state mismatch");
  await api(
    `/conversations/${chat.id}/read`,
    "POST",
    { messageId: sent.id },
    b.accessToken,
  );
  server.child.kill("SIGTERM");
  await Promise.race([
    server.done,
    delay(15000).then(() => {
      throw new Error("Graceful shutdown timed out");
    }),
  ]);
  console.log(
    "Compiled server smoke passed: isolated replica set, index setup, auth, messaging, unread/read and SIGTERM shutdown.",
  );
} finally {
  for (const child of children) child.kill("SIGKILL");
  await replica?.stop();
  await rm(dir, { recursive: true, force: true });
}
