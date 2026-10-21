import * as controller from "./controller.js";
import { Router } from "express";

import * as schemas from "./validation.js";
import { auth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { rate } from "../../infrastructure/rateLimit.js";

export const authRoutes = Router();
authRoutes.post(
  "/register",
  rate("registration", 5, 3600),
  validate(schemas.registration),
  controller.createRegister,
);
authRoutes.post(
  "/login",
  rate("login", 20, 900),
  validate(schemas.login),
  controller.createLogin,
);
authRoutes.post(
  "/verify",
  rate("verification", 15, 900),
  validate(schemas.verify),
  controller.createVerify,
);
authRoutes.post(
  "/refresh",
  rate("refresh", 30),
  validate(schemas.refresh),
  controller.createRefresh,
);
authRoutes.post(
  "/forgot-password",
  rate("forgot", 10, 3600),
  validate(schemas.forgot),
  controller.createForgotPassword,
);
authRoutes.post(
  "/reset-password",
  rate("password-reset", 20, 900),
  validate(schemas.reset),
  controller.createResetPassword,
);
authRoutes.post("/logout", auth, controller.createLogout);
authRoutes.post("/logout-all", auth, controller.createLogoutAll);
authRoutes.get("/sessions", auth, controller.getSessions);
authRoutes.delete("/sessions/:id", auth, controller.deleteSessionsById);
