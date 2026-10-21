import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { check } from "../../utils/errors.js";
import { scan } from "../../infrastructure/scan.js";
export const allowed = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
export async function validateFile(data: Buffer) {
  check(
    data.length > 0 && data.length <= env.MAX_UPLOAD_BYTES,
    413,
    "UPLOAD_SIZE",
    "Empty files and files over the upload limit are not allowed.",
  );
  let type;
  try {
    type = await fileTypeFromBuffer(data);
  } catch {
    check(false, 415, "FILE_TYPE", "File signature is incomplete or invalid.");
  }
  if (!type && !data.includes(0) && data.length < 512 * 1024) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      type = { ext: "txt", mime: "text/plain" };
    } catch {}
  }
  check(
    type && allowed.includes(type.mime),
    415,
    "FILE_TYPE",
    "This file type is not supported.",
  );
  await scan(data);
  if (type.mime.startsWith("image/")) {
    try {
      const result = await sharp(data, {
        limitInputPixels: 40e6,
        animated: false,
      })
        .rotate()
        .webp({ quality: 85 })
        .toBuffer();
      return { data: result, mime: "image/webp" };
    } catch {
      check(
        false,
        422,
        "INVALID_IMAGE",
        "The image could not be decoded safely.",
      );
    }
  }
  return { data, mime: type.mime };
}
