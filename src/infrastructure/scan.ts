import { createConnection } from "node:net";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
export async function scan(data: Buffer) {
  if (env.SCAN_MODE === "disabled") return;
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
    });
    let reply = "";
    const fail = () => {
      socket.destroy();
      reject(
        new AppError(
          503,
          "SCANNER_UNAVAILABLE",
          "File validation is temporarily unavailable.",
        ),
      );
    };
    socket.setTimeout(15000, fail);
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      for (let pos = 0; pos < data.length; pos += 32768) {
        const chunk = data.subarray(pos, pos + 32768),
          length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (part) => {
      reply += part.toString();
      if (reply.includes("\0")) {
        socket.end();
        if (reply.includes(": OK")) resolve();
        else
          reject(
            new AppError(
              422,
              "UNSAFE_FILE",
              "The file could not pass the security scan.",
            ),
          );
      }
    });
    socket.on("close", () => {
      if (!reply.includes("\0")) fail();
    });
  });
}
