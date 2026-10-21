# Frontend and Socket.IO contract

REST base: `https://YOUR_API_ORIGIN/api/v1`. Socket origin: `https://YOUR_API_ORIGIN`, Socket.IO path `/socket.io`, WebSocket transport. Schemas, paths, methods, authorization, errors and indexes are defined in [OpenAPI](../openapi.json). IDs are server-generated UUID strings; links in the shared-links gallery have synthetic attachment IDs. Timestamps are UTC ISO 8601 strings. Never infer delivery from the appearance of a bubble.

## Existing React Native frontend integration

The frontend remains in the separate `chatapp` project and was not edited by this backend task.

1. Set API_URL to the HTTPS origin **including `/api/v1`**, and SOCKET_URL to the origin. The previous proposed frontend documentation used `/v1`; this backend uses the requested `/api/v1`.
2. Keep the complete auth response securely: `{accessToken,refreshToken,expiresIn,user,needsProfileSetup}`. Add refreshToken to the frontend session type and secure-storage validation; its current schema only retains accessToken/user/setup state after restart. Never put refreshToken into AsyncStorage.
3. Refresh with `POST /auth/refresh {refreshToken}` before access expiry or on one HTTP 401. Run **one refresh request at a time**; queue other requests behind it, atomically save the replacement refreshToken, reconnect Socket.IO with the new accessToken, and retry canceled/rejected API operations once. Refresh-token replay revokes that session family, including a concurrent second refresh using the old token. On refresh 401/replay rejection, clear credentials and caches; on network errors/503, preserve secure credentials and back off instead of treating infrastructure failure as invalid authentication. Access tokens from a revoked session fail immediately.
4. Add a `session:expired` socket listener. Stop sends, refresh once when allowed, then reconnect; the server explicitly disconnects expired/revoked sockets. An initial `connect_error` with data.code SESSION_EXPIRED also requires refresh/sign-in. Current foreground HTTP 401 behavior signs out, so refresh support requires the described small frontend adapter change.
5. Registration/new passwords require 12–128 characters; the existing frontend's 8-character minimum should be raised. Verification uses six digits; reset uses eight digits. OTP is email confirmation when configured. Registration/unverified login returns `{challengeId}` instead of a session. Verification returns the full session.
6. Retain the existing message:send, message:upsert, typing:set, typing:updated, conversation:updated and presence:updated handlers. The multipart `/uploads` path and core DTO shapes match the existing app. Use GET `/uploads/:id` or refetch history to renew media links after their 180-second validity.
7. `POST /conversations/:id/delivered` or socket `message:delivered` must be sent only after the device actually receives the message. The existing frontend already sends read cursors for visible messages, so its read status implies delivery even without the additional delivered event.
8. Cursor history/search is newest first. Message search is full-word MongoDB text search. The shared gallery scans pages of messages, so an empty MIME-filtered page can still have nextCursor; keep paging. On reconnect, refetch all cached history pages and conversations to recover edits/deletes/reactions/receipts as well as new messages.

The server uses unwrapped resources. Errors have `code`, a safe `message`, optional `requestId`, and optional field `issues`. A 429 includes Retry-After. A 401 means access is expired/revoked; 403 means resource/role policy denied; 409 means a state/idempotency/capacity conflict. A failed send can still have been accepted if its ack was lost: retry with the same clientId.

## Authenticated connection

```ts
const socket = io(SOCKET_ORIGIN, {
  transports: ['websocket'],
  auth: {token: accessToken},
});
```

The server authenticates JWT signature/issuer/audience/type/expiry and checks the live session and active verified account. Each socket joins server-selected user/session rooms. Clients cannot supply room strings. Current membership is checked again on every conversation event. A maximum of ten simultaneously connected sockets per user is enforced (distributed count via the Redis adapter; small concurrent handshake races can temporarily exceed this connection convenience limit, never the authorization checks).

## Client → server events

Every event accepts an optional ack callback. Successful control events return `{ok:true}`. Failures return `{error:string,code:string}` and are never successful message acknowledgments. Rate limits are per user across instances when Redis is enabled.

| Event | Payload | Ack / rule |
|---|---|---|
| `message:send` | `{conversationId,clientId,text?,attachmentIds?,replyToId?}` | `{message: Message}` only after a majority-committed transaction. Text ≤10,000 chars, ≤5 owned ready attachments. Client ID 8–128 letters/digits/underscore/hyphen. |
| `conversation:join` | `{conversationId}` | Authorized current member only; joins the server-derived ephemeral conversation room. |
| `conversation:leave` | `{conversationId}` | Current member only; leaves the socket subscription, **not** group membership. User-level message notifications remain enabled. |
| `message:delivered` | `{conversationId,messageId}` | Monotonic delivered cursor after actual receipt by this device. |
| `message:read` | `{conversationId,messageId}` | Monotonic read cursor; implies delivered and honors read-receipt preferences. |
| `message:edit` | `{messageId,text}` | `{message}`; own live message within 15 minutes. |
| `message:delete` | `{messageId}` | `{message}` tombstone; sender or group admin. |
| `message:reaction` | `{messageId,emoji}` | `{message}`; emoji in ❤️ 👍 😂 🎉 🙏; same reaction removes it, a different reaction replaces it. |
| `typing:set` | `{conversationId,active}` | Current member, direct-block rules apply. Multiple typers are aggregated in Redis or single-instance memory; names expire after 5 seconds. |
| `sync:request` | `{conversationId,afterSeq: number}` | `{items, nextAfterSeq}` with up to 100 new messages ascending by internal sequence. Use REST history refetch for edits/deletes to older messages. |

`sync:request` is optional new-message catch-up for clients that maintain server sequence state; the existing app can simply refetch cursor history. Redis Pub/Sub is not an offline replay log and the Redis adapter does not provide Socket.IO connection state recovery. MongoDB history remains authoritative.

## Server → client events

| Event | Payload | Handling |
|---|---|---|
| `message:upsert` | Complete viewer-specific Message | Insert/replace by server ID/clientId and version. New content, edit, deletion, reactions and receipt changes use this event. |
| `conversation:updated` | `{conversationId}` | Invalidate inbox and conversation detail queries. Also used after group changes/removal. |
| `presence:updated` | No consumed payload | Refetch visible presence; online/lastSeen fields are omitted when policy disallows them. |
| `typing:updated` | `{conversationId,userNames:string[]}` | Replace typing names, exclude the viewer, expire locally after 5 seconds; empty array clears. |
| `session:expired` | `{code:'SESSION_EXPIRED'}` | Refresh/sign in; socket is disconnected. |
| Socket.IO `connect_error` | Error with `data.code` | Initial auth/rate/connection error; SESSION_EXPIRED means refresh/sign-in. |

Fanout is queued durably in the message transaction and retried asynchronously. It targets only current authorized sessions, constructs permissions/URLs for each viewer/session, and validates current membership and session revocation before publication. Removing a member prevents future content fanout regardless of stale socket rooms. A crash or Redis outage can delay events; reconnect/REST refetch is mandatory.

## Message lifecycle and consistency

1. Client shows local pending state and supplies clientId. It never generates a server timestamp/status.
2. The server transaction locks the conversation, checks membership/block/upload/reply rules, allocates an immutable sequence, inserts the message and original recipient snapshot, updates last-message/activity state, binds uploads and enqueues fanout/push work.
3. Only after commit does REST return 201 or the socket ack return `{message}` with sent/delivered/read as appropriate. A unique `(senderId,clientId)` index and immutable original-request digest prevent duplicates and conflicting reuse, including retry after an edit/deletion.
4. Explicit device delivery/read cursors determine delivered/read. Group states refer to original recipients; a member leaving does not rewrite historical receipts. Read identities are omitted when sharing is disabled.
5. Versions are monotonically increasing conversation revisions, read with message content/cursors/permissions from the same MongoDB snapshot. Stale history cannot stamp old content with a newer revision. Complete DTOs, including tombstones, must be reconciled by version; repeated events are expected.
6. Cursor history uses immutable sequence values, so new inserts do not duplicate older pages. Live inbox sort fields can move; refresh inbox rather than treating it as an immutable snapshot.

## Upload protocol

Existing native multipart: `POST /uploads`, Bearer token, one `file`, receive Attachment after validation. No client-supplied path or MIME is trusted. Server-sniffed allowed types: JPEG/PNG/WebP/GIF, MP4/QuickTime/WebM, MP4/MP3/OGG/WAV audio, PDF, UTF-8 plain text (≤512 KiB) and DOCX. Images become static WebP with orientation applied and metadata removed; image decoding is bounded to 40 million pixels. Production ClamAV failure rejects the upload. No video/audio transcoding or content moderation is implied.

Production direct-to-S3: POST `/uploads/init {name,mime,size}` → `{id,uploadUrl,headers,expiresIn:300}`; PUT bytes with the supplied headers; POST `/uploads/:id/complete`. Quarantine bytes are size/signature/scanner-validated before copying sanitized data to a distinct private key. Completion is idempotent once ready. Configure a 24-hour S3 lifecycle on the quarantine prefix to remove objects re-uploaded through an old signed PUT after completion.

Attachment URLs are signed **bearer capabilities** valid for 180 seconds. A copied URL works while its issuing session and current resource access remain valid. URLs must not be logged or leaked. The gateway rechecks issuing-session revocation, current membership and live message/avatar references before streaming; storage keys are never public. GET `/uploads/:id` renews an authorized URL. Local files are not served statically. Single explicit byte ranges are supported for media playback.

## Push

Configure FCM_PROJECT_ID and a mounted service-account file to advertise push capability. Register `{token,platform}` through PUT `/me/devices`. Tokens are encrypted and associated with the authenticated session. Background jobs recheck preferences, mute/block/membership/read state and session validity before sending notification+data payloads containing `conversationId` and `messageId`. Previews are generic by default. FCM UNREGISTERED tokens are removed. Delivery is at least once; collapse keys reduce repeated display, but external FCM acceptance is not transactionally atomic with the job record. No push delivery is claimed when provider credentials are absent.
