# Verification report

## Executed checks

Results are recorded after the final source checks complete. Integration tests use actual newly created MongoDB replica-set processes and an isolated Redis process; HTTP uses Supertest, and real Socket.IO clients connect to two separate HTTP/Socket.IO server instances. Core persistence/auth/event behavior is not implemented with mock endpoints or an in-memory repository.

## Covered behavior

Registration/login and Argon2id hashing; malformed/unknown inputs and NoSQL operator rejection; generic auth errors; refresh rotation/replay revocation; logout; hashed/encrypted expiring single-use reset/verification codes; guess limits; bearer context checks; search quotas/CORS; direct uniqueness; membership authorization; concurrent retry idempotency/conflicts; explicit delivery and read status; monotonic unread cursors; privacy; immutable pagination and indexed search; reply scope; edit/delete/reaction permissions; group roles/last admin/removal; blocks/discovery; upload signature/MIME/ownership; image sanitation; signed file access and revocation; orphan cleanup; account deletion/admin delegation; anonymous/unauthorized socket rejection; committed socket acks; viewer-specific cross-instance fanout; cross-instance revocation and typing; historical group receipts; private group avatars; index startup guard; Redis failure readiness/rate behavior.

## Not yet verified against external infrastructure

- Production AWS/S3-compatible credentials, presigned upload interoperability, bucket SSE/CORS/lifecycle and production throughput.
- A live ClamAV service/signature database, real SMTP delivery and FCM/APNs delivery. Those adapters are implemented; tests do not claim successful delivery to unavailable external accounts.
- Docker image build/Compose execution in this host (Docker is not installed), production TLS proxy topology, public deployment, backup/restore and failure/restore drills.
- React Native device integration and frontend refresh-token changes. The frontend remains in its own folder; docs/CONTRACT.md lists the exact configuration/adapter changes.
- Sustained load, large distributed clusters, cross-region failover, and independently reviewed E2EE. No E2EE implementation is claimed.

## Deliberate product limits

Email accounts/confirmation are supported; phone/SMS and third-party social login are not implemented. One reaction per user/message; edits within 15 minutes; groups ≤256, conversations ≤500 per user, sessions ≤100, sockets approximately ≤10 concurrently, push devices ≤20 and blocks ≤500. Images become static WebP. Audio/video/documents are stored and streamed without transcoding. Message search is full-word text search, not fuzzy/substring search. Bulk report administration, user-role moderation dashboards and a public deployment UI are outside the frontend API scope; reports are stored securely for operator review. Signed URLs are short-lived bearer capabilities and must not be leaked. See DESIGN.md for retained shared history and asynchronous deletion behavior.

## Final results

- `npm run typecheck`: passed with strict typing and unused-local checks.
- `npm run build`: passed; actual `dist/server.js` and `dist/database/indexes.js` executed in the compiled smoke test.
- `npm test`: 39 integration tests passed, including two real Socket.IO instances over an isolated Redis process and MongoDB replica-set transactions.
- `npm run smoke`: passed against a newly created isolated replica set; verified index setup, actual compiled startup/readiness, registration, persisted messages, unread/read state and graceful SIGTERM exit with code 0.
- Final-location verification at `/home/pawan/Desktop/chatapp-backend`: typecheck, build, Prettier check and all 39 integration tests passed again after the move.
- `npm audit --audit-level=moderate`: passed, **0 vulnerabilities** at verification time.
- `npm run dev:db` launcher: verified using an unused port and a temporary directory; replica-set initialization and clean shutdown passed. No existing MongoDB service or data directory was modified.
