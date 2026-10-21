import mongoose from "mongoose";
import argon2 from "argon2";
import { env } from "../config/env.js";
import { connectDatabase } from "./connection.js";
import { User } from "../modules/users/model.js";
import { hashPassword } from "../modules/auth/service.js";
import { registration } from "../modules/auth/validation.js";

try {
  if (env.NODE_ENV === "production") {
    throw new Error("Test user seeding is disabled in production.");
  }
  const data = registration.parse({
    name: process.env.SEED_USER_NAME || "Pawan Test",
    email: process.env.SEED_USER_EMAIL || "pawan.test@example.com",
    password: process.env.SEED_USER_PASSWORD,
  });
  await connectDatabase();
  await User.createIndexes();
  let user = await User.findOne({ email: data.email }).select("+passwordHash");
  if (!user) {
    user = await User.create({
      name: data.name,
      email: data.email,
      passwordHash: await hashPassword(data.password),
      verified: true,
      profileComplete: true,
    });
    console.log("Test user created:", data.email);
  } else {
    console.log("Existing user preserved:", data.email);
  }
  if (
    user.status !== "active" ||
    !user.verified ||
    !(await argon2.verify(user.passwordHash, data.password))
  ) {
    throw new Error(
      "Account is unavailable or its password differs; no existing credentials were changed.",
    );
  }
  console.log("Stored password verified successfully.");
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown seed error";
  console.error(
    message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, "[redacted URI]"),
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
