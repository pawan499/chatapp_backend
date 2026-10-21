import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { check } from "../utils/errors.js";
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
function path(key: string) {
  check(
    /^(private|quarantine)\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key),
    500,
    "STORAGE_KEY",
    "Invalid storage key.",
  );
  return resolve(env.DATA_DIR, "objects", key);
}
export const storage = {
  async put(key: string, data: Buffer, mime: string) {
    if (env.STORAGE === "s3")
      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: data,
          ContentType: mime,
          ServerSideEncryption: "AES256",
        }),
      );
    else {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      await writeFile(p, data, { mode: 0o600 });
    }
  },
  async remove(key: string) {
    if (env.STORAGE === "s3")
      await s3.send(
        new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
    else
      await unlink(path(key)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
  },
  async get(key: string, range?: { start: number; end: number }) {
    if (env.STORAGE === "s3") {
      const r = await s3.send(
        new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      return { stream: r.Body as Readable, length: r.ContentLength || 0 };
    }
    const p = path(key),
      s = await stat(p);
    return {
      stream: createReadStream(p, range),
      length: range ? range.end - range.start + 1 : s.size,
    };
  },
  async buffer(key: string) {
    const { stream } = await this.get(key);
    const parts: Buffer[] = [];
    let n = 0;
    for await (const value of stream) {
      const part = Buffer.from(value);
      n += part.length;
      check(
        n <= env.MAX_UPLOAD_BYTES,
        413,
        "UPLOAD_TOO_LARGE",
        "File exceeds the upload limit.",
      );
      parts.push(part);
    }
    return Buffer.concat(parts);
  },
  async signedPut(key: string, mime: string, size: number) {
    check(
      env.STORAGE === "s3",
      409,
      "DIRECT_UPLOAD_UNAVAILABLE",
      "Use multipart upload with local storage.",
    );
    return getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ContentType: mime,
        ContentLength: size,
        ServerSideEncryption: "AES256",
      }),
      { expiresIn: 300 },
    );
  },
};
