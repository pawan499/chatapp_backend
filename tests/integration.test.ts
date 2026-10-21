import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createServer, type Server } from "node:http";
import { createServer as tcpServer, createConnection } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import request from "supertest";
import { io, type Socket } from "socket.io-client";
import mongoose from "mongoose";
import sharp from "sharp";
let repl: MongoMemoryReplSet,
  dir: string,
  cacheProcess: ChildProcess | undefined,
  redisEnabled = false;
let app: ReturnType<(typeof import("../src/app.js"))["createApp"]>,
  api: ReturnType<typeof request>,
  http: Server,
  http2: Server,
  url: string,
  url2: string;
let runtime: Awaited<
    ReturnType<(typeof import("../src/sockets/server.js"))["attachSockets"]>
  >,
  runtime2: typeof runtime;
let models: typeof import("../src/database/models.js"),
  authService: typeof import("../src/modules/auth/service.js"),
  jobs: typeof import("../src/infrastructure/jobs.js"),
  cache: typeof import("../src/infrastructure/redis.js"),
  crypto: typeof import("../src/utils/crypto.js");
let hash: string;
let alice: Account, bob: Account, cara: Account;
const password = "Valid-password-123!";
type Account = {
  user: { id: string; email: string; name: string };
  accessToken: string;
  refreshToken: string;
};
const clients: Socket[] = [];
async function freePort() {
  const s = tcpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function listen(s: Server) {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const bearer = (account = alice) => `Bearer ${account.accessToken}`;
async function fixture(name: string): Promise<Account> {
  const email = `${name}-${randomUUID()}@test.invalid`.toLowerCase();
  const u = await models.User.create({
    name,
    email,
    passwordHash: hash,
    verified: true,
  });
  return (await authService.login({
    email,
    password,
    deviceName: "Test device",
  })) as Account;
}
async function direct() {
  return (
    await api
      .post("/api/v1/conversations")
      .set("Authorization", bearer())
      .send({ kind: "direct", userId: bob.user.id })
      .expect(201)
  ).body;
}
async function group() {
  return (
    await api
      .post("/api/v1/conversations")
      .set("Authorization", bearer())
      .send({
        kind: "group",
        name: "Test group",
        memberIds: [bob.user.id, cara.user.id],
      })
      .expect(201)
  ).body;
}
async function message(cid: string, account = alice, extra: object = {}) {
  return (
    await api
      .post(`/api/v1/conversations/${cid}/messages`)
      .set("Authorization", bearer(account))
      .send({
        clientId: randomUUID(),
        text: "Hello world",
        attachmentIds: [],
        ...extra,
      })
      .expect(201)
  ).body;
}
async function socket(account = alice, origin = url) {
  const client = io(origin, {
    transports: ["websocket"],
    auth: { token: account.accessToken },
    autoConnect: false,
    reconnection: false,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", reject);
    client.connect();
  });
  return client;
}
async function emit(client: Socket, event: string, data: unknown) {
  return client.timeout(5000).emitWithAck(event, data);
}
async function drain() {
  for (let i = 0; i < 200 && (await jobs.runOneJob(runtime.io)); i++);
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "luma-test-"));
  const binary =
    process.env.MONGOMS_SYSTEM_BINARY ||
    (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined);
  process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = "false";
  repl = await MongoMemoryReplSet.create({
    binary: { systemBinary: binary },
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
      dbName: `test_luma_${randomUUID().replaceAll("-", "")}`,
    },
  });
  if (spawnSync("redis-server", ["--version"]).status === 0) {
    const port = await freePort();
    cacheProcess = spawn(
      "redis-server",
      [
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        dir,
      ],
      { stdio: "ignore" },
    );
    for (let n = 0; n < 100; n++) {
      const ready = await new Promise<boolean>((resolve) => {
        const s = createConnection({ port, host: "127.0.0.1" });
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      });
      if (ready) break;
      await delay(30);
    }
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    redisEnabled = true;
  } else delete process.env.REDIS_URL;
  for (const key of [
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "FCM_PROJECT_ID",
    "FCM_CREDENTIALS_FILE",
    "S3_BUCKET",
    "S3_ENDPOINT",
  ])
    delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MONGODB_URI: repl.getUri("test_luma_integration"),
    PUBLIC_URL: "http://127.0.0.1:4000",
    DATA_DIR: dir,
    ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
    REFRESH_TOKEN_SECRET: randomBytes(32).toString("hex"),
    TOKEN_PEPPER: randomBytes(32).toString("hex"),
    MEDIA_SIGNING_SECRET: randomBytes(32).toString("hex"),
    DEVICE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    EMAIL_VERIFICATION: "false",
    STORAGE: "local",
    SCAN_MODE: "disabled",
    INSTANCE_COUNT: redisEnabled ? "2" : "1",
    DOTENV_CONFIG_QUIET: "true",
    DOTENV_CONFIG_PATH: join(dir, "test-only.env"),
  });
  models = await import("../src/database/models.js");
  authService = await import("../src/modules/auth/service.js");
  jobs = await import("../src/infrastructure/jobs.js");
  cache = await import("../src/infrastructure/redis.js");
  crypto = await import("../src/utils/crypto.js");
  await (await import("../src/database/connection.js")).connectDatabase();
  await cache.connectRedis();
  for (const model of models.models) await model.createIndexes();
  hash = await authService.hashPassword(password);
  app = (await import("../src/app.js")).createApp();
  api = request(app);
  http = createServer(app);
  http2 = createServer(app);
  const attach = (await import("../src/sockets/server.js")).attachSockets;
  runtime = await attach(http);
  runtime2 = await attach(http2);
  url = await listen(http);
  url2 = await listen(http2);
});
beforeEach(async () => {
  expect(mongoose.connection.name.startsWith("test_luma_")).toBe(true);
  for (const model of models.models) await model.deleteMany({});
  alice = await fixture("Alice");
  bob = await fixture("Bob");
  cara = await fixture("Cara");
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await delay(30);
});
afterAll(async () => {
  if (runtime) await runtime.close();
  if (runtime2) await runtime2.close();
  await delay(50);
  await mongoose.disconnect();
  if (cache?.redis?.isOpen) await cache.redis.quit();
  cacheProcess?.kill("SIGTERM");
  await repl?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe("authentication and input security", () => {
  it("registers and hashes passwords; login never exposes the hash", async () => {
    const email = `new-${randomUUID()}@test.invalid`;
    const result = await api
      .post("/api/v1/auth/register")
      .send({ email, password, name: "New person" })
      .expect(201);
    expect(result.body.accessToken).toBeTruthy();
    const saved = await models.User.findOne({ email })
      .select("+passwordHash")
      .lean();
    expect(saved?.passwordHash).toMatch(/^\$argon2id/);
    expect(saved?.passwordHash).not.toBe(password);
    expect(result.body.user.passwordHash).toBeUndefined();
    await api.post("/api/v1/auth/login").send({ email, password }).expect(200);
  });
  it("rejects weak passwords, injection, malformed JSON and unknown fields", async () => {
    await api
      .post("/api/v1/auth/register")
      .send({ name: "Short", email: "short@test.invalid", password: "short" })
      .expect(400);
    await api
      .post("/api/v1/auth/login")
      .send({ email: { $ne: null }, password })
      .expect(400);
    await api
      .post("/api/v1/auth/login")
      .send({ email: alice.user.email, password, admin: true })
      .expect(400);
    await api
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{bad")
      .expect(400);
  });
  it("uses generic login errors for absent accounts and wrong passwords", async () => {
    const a = await api
        .post("/api/v1/auth/login")
        .send({ email: alice.user.email, password: "incorrect" })
        .expect(401),
      b = await api
        .post("/api/v1/auth/login")
        .send({ email: "absent@test.invalid", password: "incorrect" })
        .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });
  it("rotates refresh tokens and revokes the family on replay", async () => {
    const rotated = await api
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: alice.refreshToken })
      .expect(200);
    expect(rotated.body.refreshToken).not.toBe(alice.refreshToken);
    await api
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: alice.refreshToken })
      .expect(401);
    await api
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${rotated.body.accessToken}`)
      .expect(401);
    const row = await models.Session.findOne({ userId: alice.user.id })
      .select("+digest")
      .lean();
    expect(row?.digest).not.toContain(alice.refreshToken);
  });
  it("logout revokes access and refresh tokens immediately", async () => {
    await api
      .post("/api/v1/auth/logout")
      .set("Authorization", bearer())
      .expect(204);
    await api.get("/api/v1/me").set("Authorization", bearer()).expect(401);
    await api
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: alice.refreshToken })
      .expect(401);
  });
  it("password-reset codes are protected, expiring, and single use", async () => {
    await api
      .post("/api/v1/auth/forgot-password")
      .send({ email: alice.user.email })
      .expect(204);
    const challenge = await models.Challenge.findOne({
      userId: alice.user.id,
      kind: "reset",
    })
      .select("+digest")
      .lean();
    expect(challenge).toBeTruthy();
    const mailJob = await models.Job.findOne({ kind: "mail" })
      .select("+secret")
      .lean();
    expect(mailJob?.secret).toBeTruthy();
    const code = crypto.decrypt(mailJob!.secret!);
    expect(challenge?.digest).not.toBe(code);
    expect(mailJob?.secret).not.toContain(code);
    await api
      .post("/api/v1/auth/reset-password")
      .send({
        email: alice.user.email,
        code,
        password: "Changed-password-456!",
      })
      .expect(204);
    await api
      .post("/api/v1/auth/reset-password")
      .send({ email: alice.user.email, code, password })
      .expect(400);
    await api.get("/api/v1/me").set("Authorization", bearer()).expect(401);
    await api
      .post("/api/v1/auth/login")
      .send({ email: alice.user.email, password: "Changed-password-456!" })
      .expect(200);
  });
  it("limits invalid challenge guesses and does not consume a good code on malformed input", async () => {
    await api
      .post("/api/v1/auth/forgot-password")
      .send({ email: bob.user.email })
      .expect(204);
    for (let i = 0; i < 5; i++)
      await api
        .post("/api/v1/auth/reset-password")
        .send({ email: bob.user.email, code: "00000000", password })
        .expect(400);
    const c = await models.Challenge.findOne({ userId: bob.user.id }).lean();
    expect(c?.attempts).toBe(5);
  });
  it("rejects tokens in the wrong context and missing authentication", async () => {
    await api.get("/api/v1/me").expect(401);
    await api
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${alice.refreshToken}`)
      .expect(401);
    await api
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: alice.accessToken })
      .expect(401);
  });
  it("denies disallowed origins and excessive search requests", async () => {
    await api.get("/health").set("Origin", "https://evil.invalid").expect(403);
    for (let i = 0; i < 30; i++)
      await api
        .get("/api/v1/contacts")
        .set("Authorization", bearer())
        .expect(200);
    await api
      .get("/api/v1/contacts")
      .set("Authorization", bearer())
      .expect(429);
  });
});
describe("conversation and message consistency", () => {
  it("direct creation is idempotent and nonmembers cannot access history", async () => {
    const c = await direct();
    expect((await direct()).id).toBe(c.id);
    await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer(cara))
      .expect(403);
    await api
      .get(`/api/v1/conversations/${randomUUID()}`)
      .set("Authorization", bearer())
      .expect(403);
  });
  it("persists exactly one message for concurrent retries and rejects conflicting reuse", async () => {
    const c = await direct(),
      clientId = randomUUID();
    const data = { clientId, text: "One message", attachmentIds: [] };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api
          .post(`/api/v1/conversations/${c.id}/messages`)
          .set("Authorization", bearer())
          .send(data),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await models.Message.countDocuments({ conversationId: c.id })).toBe(
      1,
    );
    await api
      .post(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer())
      .send({ ...data, text: "Different content" })
      .expect(409);
  });
  it("does not claim delivered until an explicit delivery/read event", async () => {
    const c = await direct(),
      m = await message(c.id);
    expect(m.status).toBe("sent");
    await api
      .post(`/api/v1/conversations/${c.id}/delivered`)
      .set("Authorization", bearer(bob))
      .send({ messageId: m.id })
      .expect(204);
    let result = await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer())
      .expect(200);
    expect(result.body.items[0].status).toBe("delivered");
    expect(result.body.items[0].version).toBeGreaterThan(m.version);
    await api
      .post(`/api/v1/conversations/${c.id}/read`)
      .set("Authorization", bearer(bob))
      .send({ messageId: m.id })
      .expect(204);
    result = await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer())
      .expect(200);
    expect(result.body.items[0].status).toBe("read");
  });
  it("keeps unread cursors monotonic and excludes own or deleted messages", async () => {
    const c = await direct(),
      one = await message(c.id),
      two = await message(c.id);
    let result = await api
      .get(`/api/v1/conversations/${c.id}`)
      .set("Authorization", bearer(bob))
      .expect(200);
    expect(result.body.unread).toBe(2);
    expect(result.body.firstUnreadMessageId).toBe(one.id);
    await api
      .post(`/api/v1/conversations/${c.id}/read`)
      .set("Authorization", bearer(bob))
      .send({ messageId: two.id })
      .expect(204);
    await api
      .post(`/api/v1/conversations/${c.id}/read`)
      .set("Authorization", bearer(bob))
      .send({ messageId: one.id })
      .expect(204);
    result = await api
      .get(`/api/v1/conversations/${c.id}`)
      .set("Authorization", bearer(bob))
      .expect(200);
    expect(result.body.unread).toBe(0);
    await message(c.id, bob);
    result = await api
      .get(`/api/v1/conversations/${c.id}`)
      .set("Authorization", bearer(bob))
      .expect(200);
    expect(result.body.unread).toBe(0);
  });
  it("honors receipt privacy and last-seen preferences", async () => {
    const c = await direct(),
      m = await message(c.id);
    await api
      .patch("/api/v1/me/preferences")
      .set("Authorization", bearer(bob))
      .send({ readReceipts: false, lastSeen: false })
      .expect(200);
    await api
      .post(`/api/v1/conversations/${c.id}/read`)
      .set("Authorization", bearer(bob))
      .send({ messageId: m.id })
      .expect(204);
    const result = await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer())
      .expect(200);
    expect(result.body.items[0].status).toBe("delivered");
    expect(result.body.items[0].readBy).not.toContain(bob.user.id);
    const user = await api
      .get(`/api/v1/users/${bob.user.id}`)
      .set("Authorization", bearer())
      .expect(200);
    expect(user.body.online).toBeUndefined();
    expect(user.body.lastSeen).toBeUndefined();
  });
  it("paginates immutable sequence cursors without duplicates and searches history", async () => {
    const c = await direct();
    for (const text of ["first token", "second token", "third token"])
      await message(c.id, alice, { text });
    const first = await api
      .get(`/api/v1/conversations/${c.id}/messages?limit=2`)
      .set("Authorization", bearer())
      .expect(200);
    await message(c.id, alice, { text: "new message" });
    const next = await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set("Authorization", bearer())
      .expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].text).toBe("first token");
    const search = await api
      .get(`/api/v1/conversations/${c.id}/messages?search=second`)
      .set("Authorization", bearer())
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    await api
      .get(`/api/v1/conversations/${c.id}/messages?cursor=malformed`)
      .set("Authorization", bearer())
      .expect(400);
  });
  it("enforces edits/deletions, toggle reactions, reply scope, and immutable retry keys", async () => {
    const c = await direct(),
      cid = randomUUID(),
      m = await message(c.id, alice, { clientId: cid });
    await api
      .patch(`/api/v1/messages/${m.id}`)
      .set("Authorization", bearer(bob))
      .send({ text: "hack" })
      .expect(403);
    const edited = await api
      .patch(`/api/v1/messages/${m.id}`)
      .set("Authorization", bearer())
      .send({ text: "Updated text" })
      .expect(200);
    expect(edited.body.version).toBeGreaterThan(m.version);
    const retry = await message(c.id, alice, { clientId: cid });
    expect(retry.id).toBe(m.id);
    expect(retry.text).toBe("Updated text");
    const reacted = await api
      .put(`/api/v1/messages/${m.id}/reaction`)
      .set("Authorization", bearer(bob))
      .send({ emoji: "👍" })
      .expect(200);
    expect(reacted.body.reactions["👍"]).toEqual([bob.user.id]);
    const toggled = await api
      .put(`/api/v1/messages/${m.id}/reaction`)
      .set("Authorization", bearer(bob))
      .send({ emoji: "👍" })
      .expect(200);
    expect(toggled.body.reactions).toEqual({});
    const c2 = await group();
    await api
      .post(`/api/v1/conversations/${c2.id}/messages`)
      .set("Authorization", bearer())
      .send({ clientId: randomUUID(), text: "Bad reply", replyToId: m.id })
      .expect(400);
    await api
      .delete(`/api/v1/messages/${m.id}`)
      .set("Authorization", bearer(bob))
      .expect(403);
    const deleted = await api
      .delete(`/api/v1/messages/${m.id}`)
      .set("Authorization", bearer())
      .expect(200);
    expect(deleted.body.deleted).toBe(true);
    expect(deleted.body.text).toBe("");
  });
  it("enforces group admin roles, last-admin invariants and member removal", async () => {
    const c = await group();
    await api
      .patch(`/api/v1/conversations/${c.id}`)
      .set("Authorization", bearer(bob))
      .send({ name: "No permission" })
      .expect(403);
    await api
      .post(`/api/v1/conversations/${c.id}/members`)
      .set("Authorization", bearer())
      .send({ userId: alice.user.id, action: "leave" })
      .expect(409);
    await api
      .post(`/api/v1/conversations/${c.id}/members`)
      .set("Authorization", bearer())
      .send({ userId: bob.user.id, action: "promote" })
      .expect(204);
    await api
      .post(`/api/v1/conversations/${c.id}/members`)
      .set("Authorization", bearer())
      .send({ userId: cara.user.id, action: "remove" })
      .expect(204);
    await api
      .get(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer(cara))
      .expect(403);
    await api
      .post(`/api/v1/conversations/${c.id}/members`)
      .set("Authorization", bearer())
      .send({ userId: alice.user.id, action: "leave" })
      .expect(204);
  });
  it("blocks direct messaging and discovery and permits unblocking", async () => {
    const c = await direct();
    await api
      .put(`/api/v1/me/blocked/${bob.user.id}`)
      .set("Authorization", bearer())
      .send({ blocked: true })
      .expect(204);
    await api
      .post(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer(bob))
      .send({ clientId: randomUUID(), text: "blocked" })
      .expect(403);
    const contacts = await api
      .get("/api/v1/contacts")
      .query({ search: bob.user.name })
      .set("Authorization", bearer())
      .expect(200);
    expect(
      contacts.body.items.some((u: { id: string }) => u.id === bob.user.id),
    ).toBe(false);
    await api
      .put(`/api/v1/me/blocked/${bob.user.id}`)
      .set("Authorization", bearer())
      .send({ blocked: false })
      .expect(204);
    await message(c.id, bob);
  });
});
describe("private files and background cleanup", () => {
  it("sniffs bytes instead of trusting MIME, strips image metadata and checks attachment ownership", async () => {
    const c = await direct(),
      png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "red" },
      })
        .png()
        .toBuffer();
    const uploaded = await api
      .post("/api/v1/uploads")
      .set("Authorization", bearer())
      .attach("file", png, {
        filename: "picture.png",
        contentType: "application/pdf",
      })
      .expect(201);
    expect(uploaded.body.mime).toBe("image/webp");
    await api
      .post(`/api/v1/conversations/${c.id}/messages`)
      .set("Authorization", bearer(bob))
      .send({
        clientId: randomUUID(),
        text: "steal",
        attachmentIds: [uploaded.body.id],
      })
      .expect(403);
    await message(c.id, alice, { attachmentIds: [uploaded.body.id] });
    const link = new URL(uploaded.body.url);
    await api.get(link.pathname + link.search).expect(200);
    await api.get(link.pathname).expect(400);
    await api
      .get(
        link.pathname +
          link.search.replace(/signature=[^&]+/, "signature=" + "0".repeat(64)),
      )
      .expect(403);
    await api
      .post("/api/v1/auth/logout")
      .set("Authorization", bearer())
      .expect(204);
    await api.get(link.pathname + link.search).expect(401);
  });
  it("rejects unsupported binaries and foreign avatar IDs", async () => {
    await api
      .post("/api/v1/uploads")
      .set("Authorization", bearer())
      .attach("file", Buffer.from([0, 1, 2, 3, 4]), {
        filename: "fake.jpg",
        contentType: "image/jpeg",
      })
      .expect(415);
    await api
      .patch("/api/v1/me")
      .set("Authorization", bearer())
      .send({ name: "Alice", avatarId: randomUUID() })
      .expect(400);
  });
  it("cleanup deletes abandoned blobs but keeps referenced uploads", async () => {
    const uploaded = await api
      .post("/api/v1/uploads")
      .set("Authorization", bearer())
      .attach("file", Buffer.from("plain document"), {
        filename: "readme.txt",
        contentType: "text/plain",
      })
      .expect(201);
    await models.Upload.updateOne(
      { _id: uploaded.body.id },
      { $set: { expiresAt: new Date(0) } },
    );
    await jobs.cleanupUploads();
    expect(await models.Upload.findById(uploaded.body.id)).toBeNull();
  });
  it("account deletion revokes access and delegates group administration through durable jobs", async () => {
    const c = await group();
    await api
      .delete("/api/v1/me")
      .set("Authorization", bearer())
      .send({ confirmation: "DELETE", password })
      .expect(202);
    await api.get("/api/v1/me").set("Authorization", bearer()).expect(401);
    await drain();
    expect(
      await models.Membership.exists({ userId: alice.user.id }),
    ).toBeNull();
    const result = await api
      .get(`/api/v1/conversations/${c.id}`)
      .set("Authorization", bearer(bob))
      .expect(200);
    expect(result.body.adminIds).toHaveLength(1);
    const u = await models.User.findById(alice.user.id)
      .select("+passwordHash")
      .lean();
    expect(u?.email).toMatch(/^deleted-/);
    expect(u?.passwordHash).toBe("deleted");
  });
});
describe("real sockets across two application instances", () => {
  it("rejects anonymous socket connections", async () => {
    const c = io(url, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: false,
    });
    clients.push(c);
    const error = await new Promise<Error>((resolve) => {
      c.once("connect_error", resolve);
      c.connect();
    });
    expect(error.message).toContain("Authentication failed");
  });
  it("authorizes rooms/events and acknowledges only a persisted message", async () => {
    const c = await direct(),
      s = await socket();
    const outsider = await socket(cara);
    expect(
      (await emit(outsider, "conversation:join", { conversationId: c.id }))
        .code,
    ).toBe("NOT_A_MEMBER");
    expect(
      (
        await emit(outsider, "message:send", {
          conversationId: c.id,
          clientId: randomUUID(),
          text: "intrusion",
        })
      ).code,
    ).toBe("NOT_A_MEMBER");
    const sent = await emit(s, "message:send", {
      conversationId: c.id,
      clientId: randomUUID(),
      text: "socket message",
    });
    expect(sent.message.status).toBe("sent");
    expect(await models.Message.findById(sent.message.id)).not.toBeNull();
    expect(
      (
        await emit(s, "message:send", {
          conversationId: c.id,
          text: { bad: true },
        })
      ).code,
    ).toBe("VALIDATION_ERROR");
  });
  it("broadcasts authorized updates across Redis instances with viewer-specific permissions", async (ctx) => {
    if (!redisEnabled) {
      ctx.skip();
      return;
    }
    const c = await direct(),
      sender = await socket(),
      recipient = await socket(bob, url2);
    const received = new Promise<Record<string, unknown>>((resolve) =>
      recipient.once("message:upsert", resolve),
    );
    const sent = await emit(sender, "message:send", {
      conversationId: c.id,
      clientId: randomUUID(),
      text: "Cross instance",
    });
    await drain();
    const event = await received;
    expect(event.id).toBe(sent.message.id);
    expect(event.clientId).toBeUndefined();
    expect((event.permissions as { edit: boolean }).edit).toBe(false);
  });
  it("revocation disconnects active sockets on both instances", async () => {
    const a = await socket(),
      b = await socket(alice, url2);
    const disconnected = Promise.all([
      new Promise<void>((r) => a.once("disconnect", () => r())),
      new Promise<void>((r) => b.once("disconnect", () => r())),
    ]);
    await api
      .post("/api/v1/auth/logout-all")
      .set("Authorization", bearer())
      .expect(204);
    await drain();
    await disconnected;
    expect(a.connected).toBe(false);
    expect(b.connected).toBe(false);
  });
});

it("verifies optional email codes once and protects their queued delivery", async () => {
  const { env } = await import("../src/config/env.js");
  env.EMAIL_VERIFICATION = true;
  try {
    const email = `otp-${randomUUID()}@test.invalid`;
    const result = await api
      .post("/api/v1/auth/register")
      .send({ email, password, name: "OTP user" })
      .expect(201);
    expect(result.body.accessToken).toBeUndefined();
    const job = await models.Job.findOne({
      kind: "mail",
      resourceId: result.body.challengeId,
    })
      .select("+secret")
      .lean();
    const code = crypto.decrypt(job!.secret!);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await api
      .post("/api/v1/auth/verify")
      .send({ challengeId: result.body.challengeId, code })
      .expect(200);
    expect(verified.body.accessToken).toBeTruthy();
    await api
      .post("/api/v1/auth/verify")
      .send({ challengeId: result.body.challengeId, code })
      .expect(400);
  } finally {
    env.EMAIL_VERIFICATION = false;
  }
});
it("preserves historical group receipts after a member leaves", async () => {
  const c = await group(),
    m = await message(c.id);
  for (const user of [bob, cara])
    await api
      .post(`/api/v1/conversations/${c.id}/read`)
      .set("Authorization", bearer(user))
      .send({ messageId: m.id })
      .expect(204);
  await api
    .post(`/api/v1/conversations/${c.id}/members`)
    .set("Authorization", bearer())
    .send({ userId: bob.user.id, action: "remove" })
    .expect(204);
  const history = await api
    .get(`/api/v1/conversations/${c.id}/messages`)
    .set("Authorization", bearer())
    .expect(200);
  expect(history.body.items[0].status).toBe("read");
  expect(history.body.items[0].readBy).toContain(bob.user.id);
});
it("supports private group avatars and prevents reusing them as message files", async () => {
  const c = await group(),
    png = await sharp({
      create: { width: 5, height: 5, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
  const upload = await api
    .post("/api/v1/uploads")
    .set("Authorization", bearer())
    .attach("file", png, { filename: "group.png" })
    .expect(201);
  await api
    .patch(`/api/v1/conversations/${c.id}`)
    .set("Authorization", bearer(bob))
    .send({ avatarId: upload.body.id })
    .expect(403);
  await api
    .patch(`/api/v1/conversations/${c.id}`)
    .set("Authorization", bearer())
    .send({ avatarId: upload.body.id })
    .expect(204);
  const details = await api
    .get(`/api/v1/conversations/${c.id}`)
    .set("Authorization", bearer(bob))
    .expect(200);
  expect(details.body.avatar).toContain(upload.body.id);
  await models.Upload.updateOne(
    { _id: upload.body.id },
    { $set: { expiresAt: new Date(0) } },
  );
  await jobs.cleanupUploads();
  expect(await models.Upload.exists({ _id: upload.body.id })).toBeTruthy();
  await api
    .post(`/api/v1/conversations/${c.id}/messages`)
    .set("Authorization", bearer())
    .send({
      clientId: randomUUID(),
      text: "no reuse",
      attachmentIds: [upload.body.id],
    })
    .expect(403);
  await api
    .post(`/api/v1/conversations/${c.id}/members`)
    .set("Authorization", bearer())
    .send({ userId: cara.user.id, action: "remove" })
    .expect(204);
  await api
    .get(`/api/v1/uploads/${upload.body.id}`)
    .set("Authorization", bearer(cara))
    .expect(403);
});
it("handles literal regex characters safely and enforces JSON body limits", async () => {
  await api
    .get("/api/v1/contacts")
    .query({ search: "[" })
    .set("Authorization", bearer())
    .expect(200);
  await api
    .post("/api/v1/auth/login")
    .send({ email: alice.user.email, password: "x".repeat(50000) })
    .expect(413);
});
it("startup checks refuse missing idempotency indexes", async () => {
  const { verifyIndexes } = await import("../src/database/verifyIndexes.js");
  await verifyIndexes();
  await models.Message.collection.dropIndex("senderId_1_clientId_1");
  try {
    await expect(verifyIndexes()).rejects.toMatchObject({
      code: "INDEXES_REQUIRED",
    });
  } finally {
    await models.Message.createIndexes();
  }
});
it("liveness stays healthy while readiness and rate limiting fail closed during Redis outage", async (ctx) => {
  if (!cache.redis) {
    ctx.skip();
    return;
  }
  cache.redis.destroy();
  try {
    await api.get("/health").expect(200);
    await api.get("/ready").expect(503);
    await api.get("/api/v1/capabilities").expect(503);
  } finally {
    await cache.redis.connect();
  }
  await api.get("/ready").expect(200);
});
it("aggregates simultaneous typers across application instances", async () => {
  const c = await group(),
    a = await socket(),
    b = await socket(bob, url2),
    viewer = await socket(cara);
  let names: string[] = [];
  viewer.on("typing:updated", (event) => {
    names = event.userNames;
  });
  await emit(a, "typing:set", { conversationId: c.id, active: true });
  await emit(b, "typing:set", { conversationId: c.id, active: true });
  for (let i = 0; i < 100 && names.length !== 2; i++) await delay(20);
  expect(names.sort()).toEqual(["Alice", "Bob"]);
  await emit(a, "typing:set", { conversationId: c.id, active: false });
  for (let i = 0; i < 100 && names.includes("Alice"); i++) await delay(20);
  expect(names).toEqual(["Bob"]);
});

it("serves complete OpenAPI with resolvable schemas and private signed-media policy", async () => {
  const result = await api.get("/api/v1/openapi.json").expect(200);
  const spec = result.body;
  expect(spec.openapi).toBe("3.1.0");
  expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/components/schemas/")
      )
        expect(spec.components.schemas[value.split("/").at(-1)!]).toBeDefined();
      else visit(value);
    }
  };
  visit(spec);
  expect(spec.paths["/api/v1/media/{id}"].get.security).toEqual([]);
  expect(spec.components.schemas.DeleteAccount.required).toContain("password");
});
it("delivers development reset mail through the real private outbox adapter and clears queued ciphertext", async () => {
  await api
    .post("/api/v1/auth/forgot-password")
    .send({ email: alice.user.email })
    .expect(204);
  const job = await models.Job.findOne({ kind: "mail" })
    .select("+secret")
    .lean();
  await jobs.runOneJob();
  const completed = await models.Job.findById(job!._id)
    .select("+secret")
    .lean();
  expect(completed?.doneAt).toBeTruthy();
  expect(completed?.secret).toBeUndefined();
  const files = await readdir(join(dir, "mail"));
  const messages = await Promise.all(
    files.map((name) => readFile(join(dir, "mail", name), "utf8")),
  );
  expect(
    messages.some(
      (text) => text.includes(alice.user.email) && /code is \d{8}/.test(text),
    ),
  ).toBe(true);
});
it("requires password reauthentication before account deletion", async () => {
  await api
    .delete("/api/v1/me")
    .set("Authorization", bearer())
    .send({ confirmation: "DELETE", password: "incorrect-password" })
    .expect(403);
  await api.get("/api/v1/me").set("Authorization", bearer()).expect(200);
});
it("purges only empty conversations after their configured retention window", async () => {
  const keep = await direct(),
    old = await group();
  const retained = await message(keep.id),
    removed = await message(old.id);
  await models.Membership.deleteMany({ conversationId: old.id });
  await models.Conversation.updateOne(
    { _id: old.id },
    { $set: { memberCount: 0, updatedAt: new Date(0) } },
    { timestamps: false },
  );
  await jobs.cleanupEmptyConversations();
  expect(await models.Conversation.findById(old.id)).toBeNull();
  expect(await models.Message.findById(removed.id)).toBeNull();
  expect(await models.Message.findById(retained.id)).not.toBeNull();
});
it("readiness rejects draining instances while liveness remains available", async () => {
  app.locals.draining = true;
  try {
    await api.get("/ready").expect(503);
    await api.get("/health").expect(200);
    await api.get("/api/v1/capabilities").expect(503);
  } finally {
    app.locals.draining = false;
  }
});

it("returns the same direct-message delete permissions that the server enforces", async () => {
  const c = await direct(),
    m = await message(c.id, bob);
  const history = await api
    .get(`/api/v1/conversations/${c.id}/messages`)
    .set("Authorization", bearer())
    .expect(200);
  expect(history.body.items[0].permissions.delete).toBe(false);
  await api
    .delete(`/api/v1/messages/${m.id}`)
    .set("Authorization", bearer())
    .expect(403);
});
