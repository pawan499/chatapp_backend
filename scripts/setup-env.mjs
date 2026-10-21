import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
let text = await readFile(new URL("../.env.example", import.meta.url), "utf8");
for (const key of [
  "ACCESS_TOKEN_SECRET",
  "REFRESH_TOKEN_SECRET",
  "TOKEN_PEPPER",
  "MEDIA_SIGNING_SECRET",
  "DEVICE_ENCRYPTION_KEY",
  "METRICS_TOKEN",
])
  text = text.replace(
    new RegExp(`^${key}=.*$`, "m"),
    `${key}=${randomBytes(32).toString("hex")}`,
  );
await writeFile(new URL("../.env", import.meta.url), text, {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Created .env with independent development keys. Existing files are never overwritten.",
);
