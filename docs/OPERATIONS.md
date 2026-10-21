# Production operations

## Required infrastructure

Node 22.13+; authenticated TLS-enabled MongoDB replica set or managed cluster; private S3-compatible bucket; healthy ClamAV; SMTP; HTTPS/WSS gateway; managed secrets. Redis is optional for a single API process and required for multiple instances. FCM is optional native push. The included Compose file is only for local unauthenticated infrastructure, with loopback-bound ports.

1. Install with `npm ci`, run checks/build, provide environment values, then run `npm run indexes` using a controlled migration identity.
2. Start `node dist/server.js`. The server verifies replica-set support and critical unique indexes before listening. Failed startup logs a safe failure type; check configuration, required indexes and dependency availability.
3. Route HTTPS traffic and WebSocket upgrades to the private Node port. Set TRUST_PROXY_HOPS to the exact known topology and prevent direct public access. WebSocket-only Socket.IO does not require polling affinity; the Redis adapter is still required for cross-instance room delivery.
4. Configure readiness `/ready`, liveness `/health`, and protected `/metrics`. Drain traffic before SIGTERM; the process has a 30-second shutdown deadline and leaves unfinished leased jobs recoverable. Process managers should restart failed processes and wait for readiness before routing traffic.
5. Keep at least one API instance running for realtime/revocation outbox delivery. `npm run worker` can add mail/push/account/media-cleanup capacity without accepting HTTP traffic. Every worker shares MongoDB and the same cryptographic/provider configuration. Redis adapter, distributed quotas and ephemeral state use the same Redis deployment.

## Object storage

Disable public access/ACLs; require encryption at rest and private workload identity permissions for only the configured bucket/prefixes. The adapter requests SSE-S3 AES256. Configure your S3-compatible provider to support it. Private final objects are streamed through the API after access checks, not exposed as unrestricted public URLs. Browser uploads need bucket CORS restricted to your actual web origins; native uploads are not browser-CORS constrained.

Presigned PUTs target quarantine, expire after 5 minutes, and include declared length/content type/encryption headers. Completion reads a bounded stream, verifies actual length/signature, performs malware scanning/image sanitation, writes a distinct final key, then marks metadata ready. An old PUT cannot overwrite the finalized object. Configure quarantine lifecycle expiration after 24 hours to clean re-uploads through still-valid old URLs. Abandoned/final unreferenced metadata is also cleaned by the worker.

ClamAV belongs on a private trusted network; the INSTREAM adapter fails closed on timeout/unavailability/malware. Development-only disabled scanning is rejected in production configuration. Keep signature databases updated and monitor scanner readiness and latency. Images become static WebP with metadata removed; video/audio/document transcoding is not provided.

## Redis and failure behavior

Use authenticated encrypted Redis outside a protected local environment. The Socket.IO adapter uses dedicated publish/subscribe connections, while rate limiting/presence/typing use the primary client. Multi-instance startup requires REDIS_URL. Counters use atomic increment/expiry; presence uses socket IDs with heartbeat expiry, so killed processes cannot leave permanent online users. MongoDB remains authoritative.

Redis outages cause readiness failure and reject rate-limited API/event work with 503. Reconnect and REST history refetch recover missed live notifications. Pub/Sub is not durable replay. Use a supervised Redis deployment and alert on connection failures; do not rely on in-memory counters when horizontally scaled.

## Monitoring and retries

Prometheus exports HTTP counts/durations with normalized route labels, process metrics, pending/dead job counts and oldest ready-job age. Alert on 5xx/429 spikes, latency, MongoDB replica lag/pool pressure, Redis disconnects, scanner failures, SMTP/FCM failures and any dead jobs or growing job lag. Pino emits request IDs and structured security audit metadata without credentials/message content. Integrate these safe structured failures with your monitoring system; no proprietary error-monitoring account is required.

Job leases renew while processing. Failures back off exponentially, cap delay at 5 minutes, and dead-letter after 10 attempts. Completed/dead job records expire after 7 days, so export incident details before that retention window. Once a root cause is fixed, use a controlled migration/admin script to reset only the intended dead job IDs (`dead:false`, `attempts:0`, `leaseUntil:new Date(0)`, `availableAt:new Date()`) and audit the operation. Never reset the entire queue blindly. Realtime events are at least once; clients deduplicate by ID/clientId/version. FCM may display a duplicate after an acceptance/ack race; collapse keys reduce repeats without claiming exactly-once external delivery.

## Index rollout and migrations

Schemas declare indexes per module. `npm run indexes` calls createIndexes, not syncIndexes, so it does not drop existing indexes. Back up before changes, inspect duplicates before unique indexes, build compatible indexes before deploying code that requires them, and monitor I/O/replication impact. Critical unique indexes are checked on API/worker startup. Roll out backward-compatible additive fields first, backfill in bounded batches, then deploy readers/writers, and only later remove old fields/indexes in a separate reviewed migration.

Use distinct least-privilege identities for application runtime and schema/index migrations. Prevent runtime operators from accidentally pointing scripts at the wrong environment. There are no application endpoints that drop databases, flush Redis, expose outbox codes, or administer reports.

## Backup and restore

Use the database provider's consistent replica-set backup/PITR capability and private encrypted object-storage versioning/backup, with retention coordinated with deletion policy. For a small self-managed maintenance backup, `mongodump --uri "$MONGODB_URI" --oplog --out <private-backup-dir>` requires a supported replica-set connection and appropriate privileges; keep the URI in secret-managed environment and shell tracing disabled. Snapshot object storage with a manifest/time boundary corresponding to database metadata.

Restore first into an **isolated** environment with no public ingress or outbound notifications. For a full dump, review `mongorestore --uri "$RESTORE_URI" --oplogReplay <private-backup-dir>` against your MongoDB version and backup format; never use destructive restore flags against a live database. Restore matching object versions, validate collection counts/indexes/references, replay deletion/retention actions since the backup, rotate credentials/session keys if the incident requires it, run authorization/message/receipt checks, then rehearse a controlled cutover. Document and measure RPO/RTO through regular restore drills. Backup/restore commands have not been run against a user database by this project.

## Secret rotation

Rotate access/refresh signing keys with a planned reauthentication window; the current single-key scheme intentionally invalidates old JWTs rather than implementing an unverified multi-key protocol. Rotating TOKEN_PEPPER invalidates existing refresh/code digests. MEDIA_SIGNING_SECRET rotation invalidates media links, which clients can renew. DEVICE_ENCRYPTION_KEY rotation requires a controlled decrypt/re-encrypt migration for device tokens and pending mail codes, or removing those records and re-registering/re-requesting them. Keep secrets out of source, logs, container images and tickets.

## Future scaling

The first scaling step is multiple API instances with Redis, shared MongoDB and shared private object storage. Add dedicated mail/push/cleanup workers as queue lag grows. Profile fanout and the 256-member/500-conversation/100-session convenience caps before increasing them. At much larger scale, partition event processing, coalesce receipt/presence fanout, use managed full-text search, and add provider-specific idempotency/observability. Do not enable Redis connection state recovery assumptions: this adapter requires application resync. No sharding, cross-region active-active guarantees, or benchmarked throughput is claimed.

References: [MongoDB transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/), [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter), [OWASP file upload controls](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [OWASP token rotation guidance](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html).
