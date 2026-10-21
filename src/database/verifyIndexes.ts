import {
  User,
  Membership,
  Conversation,
  Message,
  Device,
  Receipt,
} from "./models.js";
import { check } from "../utils/errors.js";
export async function verifyIndexes() {
  for (const [model, name] of [
    [User, "email_1"],
    [Membership, "userId_1_conversationId_1"],
    [Conversation, "directKey_1"],
    [Message, "senderId_1_clientId_1"],
    [Device, "tokenHash_1"],
    [Receipt, "conversationId_1_userId_1"],
  ] as const) {
    let valid = false;
    try {
      valid = (await model.collection.indexes()).some(
        (index) => index.name === name && index.unique === true,
      );
    } catch {}
    check(
      valid,
      503,
      "INDEXES_REQUIRED",
      "Required unique indexes are missing. Run npm run indexes before starting the API.",
    );
  }
}
