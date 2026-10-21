import { z } from "zod";
import { id } from "../../utils/pagination.js";
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const password = z.string().min(12).max(128);
export const deviceName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .default("Mobile device");
export const registration = z
  .object({
    name: z.string().trim().min(2).max(80),
    email,
    password,
    deviceName,
  })
  .strict();
export const login = z
  .object({ email, password: z.string().min(1).max(128), deviceName })
  .strict();
export const verify = z
  .object({ challengeId: id, code: z.string().regex(/^\d{6}$/) })
  .strict();
export const forgot = z.object({ email }).strict();
export const reset = z
  .object({ email, code: z.string().regex(/^\d{8}$/), password })
  .strict();
export const refresh = z
  .object({ refreshToken: z.string().min(20).max(2048) })
  .strict();
