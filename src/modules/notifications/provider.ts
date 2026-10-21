import { GoogleAuth } from "google-auth-library";
import { env } from "../../config/env.js";
import { decrypt } from "../../utils/crypto.js";
import {
  Device,
  User,
  Membership,
  Message,
  Session,
  Block,
} from "../../database/models.js";
const google = new GoogleAuth({
  keyFile: env.FCM_CREDENTIALS_FILE,
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
});
export async function deliverPush(deviceId: string, messageId: string) {
  if (!env.FCM_PROJECT_ID) return;
  const device = await Device.findById(deviceId)
    .select("+encryptedToken")
    .lean();
  if (
    !device ||
    !(await Session.exists({
      _id: device.sessionId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }))
  )
    return;
  const [user, message] = await Promise.all([
    User.findById(device.userId).lean(),
    Message.findById(messageId).lean(),
  ]);
  if (
    !user ||
    !message ||
    message.deleted ||
    message.senderId === device.userId ||
    !user.preferences.notifications
  )
    return;
  const membership = await Membership.findOne({
    conversationId: message.conversationId,
    userId: device.userId,
  }).lean();
  if (!membership || membership.muted || membership.readSeq >= message.seq)
    return;
  if (
    await Block.exists({
      $or: [
        { ownerId: device.userId, targetId: message.senderId },
        { ownerId: message.senderId, targetId: device.userId },
      ],
    })
  )
    return;
  try {
    await google.request({
      url: `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
      method: "POST",
      timeout: 10000,
      data: {
        message: {
          token: decrypt(device.encryptedToken),
          notification: {
            title: "New message",
            body: user.preferences.previews
              ? message.text.slice(0, 140) || "New attachment"
              : "You have a new message",
          },
          data: { conversationId: message.conversationId, messageId },
          android: { collapse_key: message.conversationId },
          apns: { headers: { "apns-collapse-id": message.conversationId } },
        },
      },
    });
  } catch (e) {
    const status = (
      e as {
        response?: {
          status: number;
          data?: { error?: { details?: { errorCode?: string }[] } };
        };
      }
    ).response;
    const codes = status?.data?.error?.details?.map((d) => d.errorCode) || [];
    if (codes.includes("UNREGISTERED")) {
      await Device.deleteOne({ _id: deviceId });
      return;
    }
    throw e;
  }
}
