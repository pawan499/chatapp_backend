# Data model, security and retention

## Collections and transaction boundaries

Models are feature-scoped under `src/modules`; `database/models.ts` is a shared registry, not a second schema implementation. Routes validate and delegate to controllers; domain services own mutations, authorization and transactions; repositories handle read queries; serializers batch related lookups. Socket and REST handlers call the same message/group services.

- **Users:** unique normalized email, Argon2id hash excluded by default, profile, verification/status, privacy preferences, conversation count and policy version. Names/bios/emails are visible to authenticated contact discovery; presence/bio/avatar visibility also follows block/privacy policy. The app supports email accounts, not phone/SMS accounts.
- **Sessions:** opaque UUID family, user, keyed refresh-token digest, absolute expiry and revocation. Access and refresh JWTs use separate keys, audiences and kind claims. Every protected request/event checks the live session, enabling immediate revocation. Mongo TTL is housekeeping; authorization always checks expiry explicitly.
- **Challenges:** keyed digests, type, expiry, guess counter and single-use marker. Codes are never plaintext database fields. A queued mail code is AES-256-GCM encrypted, and its ciphertext is removed when the job completes. Development outbox files are private local files, not logs/public endpoints.
- **Conversations:** direct/group type, unique partial direct-pair key, group metadata, scalar counts, immutable sequence allocator, revision and last-message ID. Messages and membership histories are not embedded unbounded arrays.
- **Memberships:** unique `(userId,conversationId)`, role, per-user settings, read/delivered cursors and inbox activity. Capacity: 256 group participants, 500 conversations per user. Membership is checked for every resource operation; the conversation lock serializes sends versus removal/role changes.
- **Messages:** immutable sender/clientId/request digest/sequence/timestamp, content, up to 5 attachment IDs, reply reference, version, edit/tombstone flags, up to 20 extracted HTTPS links and a bounded original-recipient snapshot. Unique sender/clientId and conversation/sequence indexes enforce retry and ordering consistency. Edits preserve the original request digest so a lost-ack retry still resolves after an edit.
- **Receipts:** normalized per-conversation/user cursor records retain historical receipt progress after membership removal. Message versions derive from a monotonic conversation revision with snapshot reads; receipt changes do not rewrite millions of historical documents. Durable receipt jobs fan out affected ranges in bounded batches.
- **Reactions:** normalized `(messageId,userId)` unique rows; one emoji per member, replace/toggle semantics.
- **Uploads:** owned private object key, actual sanitized MIME/size, pending/ready/deleting state and assignment metadata. Local objects are under a private generated path; S3 uses private quarantine/final prefixes. Only ready owned assets can be attached; message/profile/group assignments are mutually exclusive.
- **Blocks/reports/devices:** unique owner/target blocks; bounded report reasons with 180-day TTL; FCM token keyed digest plus authenticated encryption, owned session and platform. Up to 500 blocked contacts and 20 push devices per user. New session creation caps active sessions at 100 by revoking the oldest.
- **Jobs:** MongoDB outbox with lease, attempts, availability, completion and dead-letter state. Mutations enqueue related work in the transaction; at-least-once workers tolerate duplicate realtime events. A separate worker may handle mail/push/cleanup; API instances handle realtime/revocation fanout. Completed/dead job metadata expires after 7 days.

Direct block changes and direct sends also lock involved user policy records in sorted ID order, preventing a concurrent block from being bypassed by a snapshot-read race. Group blocks stop direct interaction/discovery; existing shared-group content remains visible. New group members can view prior group history; their initial unread cursor starts at the join sequence.

Unread counts are derived using indexed incoming live messages after the viewer’s read cursor, excluding own/deleted content. Last-message ID, activity, message insert and outbox insert commit together. Inbox/message serializers use a coherent MongoDB snapshot; online presence remains intentionally ephemeral. No client permission/status/URL/timestamp is trusted.

## Security controls

Zod strict objects reject unknown fields and query operators; all resource IDs/cursors are validated. Searches escape literal regex characters and message search uses an indexed text query. Server-side body/file/event limits, bounded fanout/group sizes, auth/search/upload/message quotas, and distributed atomic Redis counters constrain abuse. Redis rate-store failure fails protected requests closed instead of silently allowing traffic.

Helmet and exact CORS allowlists are installed. No cookies are used for authentication; bearer credentials belong in native platform secure storage. Production HTTP handlers require TLS via a correctly configured private trusted proxy. WebSocket transport must also be terminated by that TLS gateway. Origins do not replace authentication.

Pino logs request IDs, methods, paths without query strings and status, never request bodies, headers, message text, codes or tokens. Administrative membership/account/session actions write structured audit metadata. Restrict logs to operators and set retention in the logging system. Errors return safe messages without stack traces. Metrics contain normalized route patterns, not resource IDs, and require a production metrics credential.

This is HTTPS/WSS transport protection and access control. **End-to-end encryption is not implemented or claimed.** A full threat review, provider IAM review, load test and deployment-specific hardening are required for a release.

## Retention and deletion

- Logout revokes the chosen session and removes its push tokens. Logout-all/password reset/account deletion revoke every session; access checks fail immediately, and durable jobs disconnect sockets across instances.
- Account deletion requires the current password plus confirmation DELETE. Access is revoked and profile PII/password/verification state is scrubbed in the transaction. Membership cleanup is queued and delegates the last admin role to another remaining member. Its 202 response means access removal is done and cleanup is still asynchronous.
- Authored content in conversations with remaining members is retained so their history remains coherent; sender identity becomes Deleted account. Account deletion does not silently erase other members’ shared history. Reports are operator-only database records and expire after 180 days.
- Message deletion immediately returns a content-free tombstone, clears reaction/link/reply/attachment references, and makes the old media reference inaccessible. Retired objects are held for RETENTION_DAYS (default 30) before cleanup; no API exposes retired content. Replaced avatars follow the same retention period.
- Empty conversations and their message/reaction/receipt records are purged after RETENTION_DAYS. Remaining referenced message/active avatar objects are retained. Abandoned unassigned uploads expire after 24 hours. Cleanup checks references and marks the upload deleting in a transaction before deleting storage bytes, preventing a concurrent send from attaching a deleted object.
- S3 quarantine needs an external 24-hour lifecycle rule; storage-provider versioning/backups may retain old bytes beyond logical deletion and need their own documented lifecycle. Database/object backup retention is an operator policy; restore procedures must replay deletion records before exposing restored data.

The defaults are product choices, not jurisdiction-specific compliance guarantees. Deployment owners must set retention and access policy appropriate to their actual requirements.
