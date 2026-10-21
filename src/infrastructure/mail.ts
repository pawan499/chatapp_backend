import nodemailer from "nodemailer";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { env } from "../config/env.js";
export async function sendCode(
  to: string,
  code: string,
  kind: "verify" | "reset",
) {
  const message = {
    from: env.MAIL_FROM,
    to,
    subject:
      kind === "verify"
        ? "Verify your Luma account"
        : "Reset your Luma password",
    text: `Your ${kind === "verify" ? "verification" : "password reset"} code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
  };
  if (env.SMTP_HOST) {
    await nodemailer
      .createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
        connectionTimeout: 5000,
        socketTimeout: 10000,
      })
      .sendMail(message);
  } else {
    const dir = resolve(env.DATA_DIR, "mail");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(dir, `${randomUUID()}.json`),
      JSON.stringify(message),
      { mode: 0o600 },
    );
  }
}
