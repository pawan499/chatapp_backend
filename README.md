# Luma Chat API

A separate Node.js/TypeScript backend for the Luma bare React Native app. Express 5, MongoDB/Mongoose, Socket.IO, Zod, Argon2id, access/refresh JWTs, Pino and Vitest/Supertest. MongoDB is the system of record. Firebase is used only as an optional FCM push delivery provider; it does not replace authentication, storage, or messaging.

## Run locally

```bash
cd /home/pawan/Desktop/chatapp-backend
npm ci
npm run setup:env
# Creates a private .env with independent random development keys; refuses to overwrite an existing file.
docker compose up -d mongo mongo-init
npm run indexes
npm run dev
```

If Docker is unavailable but `mongod` is installed (as on this machine), start `npm run dev:db` in another terminal instead of Compose. It creates a **persistent local** replica set under `.data/mongo`, binds only `127.0.0.1:27018`, and refuses to touch a port already in use. Keep that terminal running, then run indexes/dev in the application terminal. DEV_MONGO_PORT and DEV_MONGO_DIR override the isolated development defaults; update MONGODB_URI to match if changed. It stops only its own child process on Ctrl+C.

Node 22.13+ is required (verified on 22.23). The default port is 4000. API base: `http://127.0.0.1:4000/api/v1`; Socket.IO origin: `http://127.0.0.1:4000`, path `/socket.io`, WebSocket transport. Production and physical-device frontend builds should use your HTTPS origin or an HTTPS development tunnel. The mobile frontend's API_URL must include `/api/v1`; SOCKET_URL is the origin.

MongoDB **must be a replica set**, including development, because message acceptance, membership changes, resets and token rotation use multi-document transactions with majority write concern. The included Compose replica set is a local convenience with loopback-only ports and no authentication. Do not deploy that MongoDB configuration to production. To use an existing development replica set, change MONGODB_URI in the generated .env instead of starting Compose. Do not modify or reuse a production database for testing.

After compilation, the production image can run migrations with `npm run indexes:production`; an additional worker uses `npm run worker` (`npm run worker:dev` runs source during development).

Run `npm run indexes` before the first startup and each index rollout. It creates declared indexes without dropping existing indexes. API and worker startup refuse to run when the critical unique indexes are missing. Automatic production index builds are disabled. See [operations](docs/OPERATIONS.md) for migrations and backup/restore.

## What works

- Registration/login; optional email verification; queued email delivery; expiring, hashed verification/reset codes; password reset; access/refresh tokens; refresh rotation/replay detection; current/all-session logout; owned session revocation and account deletion with password confirmation.
- Profiles, avatar sanitation, server-backed privacy/notification preferences, contact discovery, blocks and reports.
- Idempotent direct chats, groups, bounded membership documents, admin promotion/demotion, last-admin protection, group name/description/avatar, per-user pin/mute/archive.
- REST and socket message submission, durable acceptance acknowledgments, replies, permission-checked edits/deletion, toggle reactions, cursor history, full-word message search, unread state, explicit delivery/read cursors, historical group recipient snapshots and privacy-aware receipts.
- Authenticated sockets, authorized room join/leave, reconnect resync, cross-instance typing and presence, membership removal, token expiry and session revocation.
- Private local development storage or private S3-compatible production storage, multipart upload, signed S3 upload initialization/completion, signature/MIME verification, malware scanning, image metadata stripping, short-lived revocable media links and byte ranges.
- MongoDB-backed durable jobs for realtime fanout, email, FCM push, membership cleanup and media cleanup; bounded retries/dead letters; Redis adapter/distributed rate limits/presence when configured.
- Health/readiness, structured redacted logs, request IDs, Prometheus request/process/job metrics, deployment files, OpenAPI, and isolated integration tests.

## Documentation

- [OpenAPI 3.1](openapi.json): exact request/response schemas, authentication, permissions, pagination and relevant indexes for 46 REST operations. Served at `/api/v1/openapi.json`; import it into an OpenAPI/Swagger viewer.
- [Frontend and socket contract](docs/CONTRACT.md): exact event names, ack behavior, message lifecycle, refresh handling and migration notes for the existing frontend.
- [Security/data model/retention](docs/DESIGN.md).
- [Production operations](docs/OPERATIONS.md).
- [Verification and limitations](docs/VERIFICATION.md).

Success responses are unwrapped JSON resources, list responses are `{items,nextCursor}`, and errors are `{code,message,requestId?,issues?}`. `/me/blocked` remains a bounded bare array for the existing frontend. Codes and credentials are never returned in HTTP logs or ordinary plaintext token fields.

## Configuration

`.env.example` contains placeholders only and deliberately fails secret validation. Use `npm run setup:env` for development, then edit URLs and provider settings. Supply production values through a secret manager or mounted secrets.

| Settings | Behavior |
|---|---|
| `MONGODB_URI` | Replica-set or sharded MongoDB URI; production TLS/auth required by deployment policy. |
| `PUBLIC_URL` | External API origin (HTTPS in production), used to create signed media links. |
| `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET` | Distinct high-entropy values, at least 32 characters. Access defaults to 15 minutes; session/refresh lifetime defaults to 30 days absolute. |
| `DEVICE_ENCRYPTION_KEY` | 64 hex characters; AES-256-GCM encryption for FCM tokens and queued mail codes. |
| `CORS_ORIGINS` | Comma-separated exact browser origins; native clients with no Origin header authenticate using JWTs. No wildcard production configuration. |
| `TRUST_PROXY_HOPS` | Set only for your known TLS-terminating proxy topology; keep the Node port private. |
| `REDIS_URL`, `INSTANCE_COUNT` | Redis is optional for one instance and mandatory for more than one. Redis failures fail rate limiting closed. |
| `EMAIL_VERIFICATION` | If true, registration/unverified login returns challengeId; a six-digit email code creates the session. This is email confirmation, not a claimed MFA implementation. |
| `SMTP_*`, `MAIL_FROM` | Actual SMTP delivery when configured. Without SMTP in development, messages are written under DATA_DIR/mail with 0600 file permissions. There is no public outbox endpoint. SMTP is required in production. |
| `STORAGE` | `local` for development; `s3` required in production. Configure bucket/region/optional endpoint/path-style settings and workload identity or standard AWS credentials. |
| `SCAN_MODE` | `disabled` for local development only, or `clamav`; production requires ClamAV and fails uploads closed when unavailable. |
| `FCM_PROJECT_ID`, `FCM_CREDENTIALS_FILE` | Optional native push; mount the service-account JSON read-only, never commit it. The account needs only FCM send permissions. |
| `METRICS_TOKEN` | Required in production; protects `/metrics`. |
| `MAX_UPLOAD_BYTES`, `RETENTION_DAYS` | Default 20 MiB per file, 30 days for retired objects/empty conversations. Coordinate changed upload limits with clients and OpenAPI. |

For optional Redis: `docker compose --profile scale up -d redis`, then set REDIS_URL to `redis://127.0.0.1:6381`. For local scanning: `docker compose --profile scan up -d clamav`; allow its signature database to become ready, then set SCAN_MODE=clamav. Neither optional component replaces MongoDB.

## Checks

```bash
npm run typecheck
npm run check:format
npm run build
npm test
npm run smoke
npm audit
```

Tests create their **own MongoDB replica-set process on temporary ports**. They ignore external database configuration, require a test database-name guard before deleting fixtures, and remove the temporary instance on completion. An installed `mongod` is used when available; otherwise mongodb-memory-server downloads a binary. Set MONGOMS_SYSTEM_BINARY explicitly if required. If `redis-server` is installed, tests also start an isolated Redis process and verify two Socket.IO instances; otherwise Redis-specific cases are skipped. No test flushes an existing Redis server or touches an existing MongoDB instance.

## Build and deploy

```bash
npm run build
NODE_ENV=production npm start
# Optional additional non-realtime workers:
npm run worker
# Container image:
docker build -t luma-chat-api .
```

Production startup requires HTTPS public configuration, private S3 storage, ClamAV, SMTP, explicit CORS and a metrics token. Expose the app only behind a trusted TLS gateway. Supply runtime configuration using your deployment's secret manager; do not bake `.env` or credential files into images. The Docker image runs as a non-root user. Deployment, S3/SMTP/FCM/ClamAV credentials, real-device integration and load tests must be verified in your environment before releasing; see the verification report for what was actually executed.
