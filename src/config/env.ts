import "dotenv/config";
import { z } from "zod";
const secret = z
  .string()
  .min(32)
  .refine(
    (s) => !s.includes("CHANGE_ME"),
    "Replace example secrets before starting.",
  );
const boolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z.string().startsWith("mongodb"),
    PUBLIC_URL: z.url(),
    CORS_ORIGINS: z.string().default(""),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    ACCESS_TOKEN_SECRET: secret,
    REFRESH_TOKEN_SECRET: secret,
    TOKEN_PEPPER: secret,
    MEDIA_SIGNING_SECRET: secret,
    DEVICE_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
    ACCESS_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
    REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    EMAIL_VERIFICATION: boolean,
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default("Luma <noreply@example.invalid>"),
    STORAGE: z.enum(["local", "s3"]).default("local"),
    DATA_DIR: z.string().default(".data"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: boolean,
    REDIS_URL: z.url().optional(),
    INSTANCE_COUNT: z.coerce.number().int().min(1).default(1),
    SCAN_MODE: z.enum(["clamav", "disabled"]).default("disabled"),
    CLAMAV_HOST: z.string().default("127.0.0.1"),
    CLAMAV_PORT: z.coerce.number().default(3310),
    FCM_PROJECT_ID: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    FCM_CREDENTIALS_FILE: z.string().optional(),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    METRICS_TOKEN: secret.optional(),
    LOG_LEVEL: z
      .enum(["debug", "info", "warn", "error", "silent"])
      .default("info"),
  })
  .superRefine((v, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    if (
      v.ACCESS_TOKEN_SECRET === v.REFRESH_TOKEN_SECRET ||
      new Set([
        v.ACCESS_TOKEN_SECRET,
        v.REFRESH_TOKEN_SECRET,
        v.TOKEN_PEPPER,
        v.MEDIA_SIGNING_SECRET,
      ]).size !== 4
    )
      issue("Signing keys and pepper must be distinct.");
    if (v.INSTANCE_COUNT > 1 && !v.REDIS_URL)
      issue("Multiple instances require Redis.");
    if (v.STORAGE === "s3" && !v.S3_BUCKET) issue("S3_BUCKET is required.");
    if (!!v.FCM_PROJECT_ID !== !!v.FCM_CREDENTIALS_FILE)
      issue("Set both FCM configuration fields.");
    if (v.NODE_ENV === "production") {
      if (!v.PUBLIC_URL.startsWith("https://"))
        issue("Production PUBLIC_URL requires HTTPS.");
      if (v.STORAGE !== "s3") issue("Production requires private S3 storage.");
      if (v.SCAN_MODE !== "clamav")
        issue("Production uploads require malware scanning.");
      if (!v.METRICS_TOKEN) issue("Production metrics require METRICS_TOKEN.");
      if (!v.SMTP_HOST) issue("Production requires SMTP for password resets.");
      if (!v.CORS_ORIGINS || v.CORS_ORIGINS.includes("*"))
        issue("Production requires an explicit CORS allowlist.");
    }
  });
export const env = schema.parse(process.env);
export const origins = env.CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
