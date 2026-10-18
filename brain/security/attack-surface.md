# Attack Surface — mprnt-backend

> Assessed 2026-10-05 at commit `dd1221b`. Base path for the API is
> `/api/${API_VERSION}` (default `/api/v1`, `src/app.ts:171-180`). Line numbers refer to
> the route declaration in the source file. "Session token" = `X-Session-Token`
> header checked by `src/middleware/sessionAuth.ts`.

Global middleware applied to **every HTTP route** (not to WebSocket upgrades), in order (`src/app.ts:26-72`):
`trust proxy = 1` → `helmet()` → `cors({ origin: CORS_ORIGIN list, credentials: CORS_CREDENTIALS })` → `trustedProxy` → `globalRateLimiter` (default 100 req / 60 s / IP, in-memory) → `express.json` (10 MB) → `express.urlencoded` (extended, 10 MB) → `compression` → `morgan`.
Error handling: `notFoundHandler` (echoes `req.originalUrl` in JSON) and `errorHandler` (generic 500).

Important behaviour of the session-token middleware: when the referenced session/job/document/order **does not exist**, the request is passed to the handler (`sessionAuth.ts:32-35`) after only checking that the header is present. Handlers then normally return 404 — but anything that runs before the 404 (multer buffering, the Razorpay call in `/payment/verify`) is reachable without a valid token.

---

## 1. Public (unauthenticated) endpoints

| Method & path | File:line | Controls | Notes / risk |
|---|---|---|---|
| `GET /` | `src/app.ts:183` | global limiter | Name, API version. |
| `GET /health` | `src/app.ts:104` | global limiter | Returns `environment` (NODE_ENV) and process uptime — minor fingerprinting. |
| `GET /health/ready` | `src/app.ts:163` | global limiter | Runs `SELECT 1`; no error detail. Can be used to generate DB load at the global rate limit. |
| `GET /api-docs`, `GET /api-docs.json` | `src/config/swagger.ts:303-319` | global limiter | Swagger UI in all environments. The description claims "Currently no authentication required" and lists rate limits that do not match the code — misleading documentation for integrators. Spec is generated from `./src/routes/*.ts`, so content depends on whether `src/` is present at runtime. |
| `POST /api/v1/sessions` | `src/routes/sessions.ts:159` | `sessionRateLimiter` 10/min/IP, Joi (`kioskId` optional string) | Creates a session + 256-bit secret; stores client IP and user agent. Without `kioskId`, auto-assigns the first active idle kiosk. |
| `POST /api/v1/payment/webhook` | `src/routes/payment.ts:243` | HMAC-SHA256 of raw body with `RAZORPAY_WEBHOOK_SECRET`, constant-time (`paymentService.ts:244-250`) | 503 when secret unset; replays are idempotent (captured/refunded short-circuit). Raw body captured only when `originalUrl` ends with `/payment/webhook` (`app.ts:49-53`). |
| `POST /api/v1/public/leads` | `src/routes/public.ts:39` | `leadRateLimiter` 5/15 min/IP, Joi (lengths), honeypot `website` | Stores name/email/phone/company/message + IP + UA (`leadService.ts:53`). |
| `GET /api/v1/public/pricing?kioskId=` | `src/routes/public.ts:52` | global limiter | Resolved B/W and colour price and minimum charge for any kiosk code. |
| `GET /api/v1/setup/kiosks` | `src/routes/setup.ts:106` | global limiter | Lists every kiosk's code, name, location, status, capabilities (internal columns excluded). |
| `POST /api/v1/setup/kiosks` | `src/routes/setup.ts:39` | `developmentOnly` (404 only if `NODE_ENV === 'production'`) | Creates table / inserts demo kiosks; returns `SELECT * FROM kiosks`. Reachable in any non-production deployment. |
| `POST /api/v1/payment/mock/simulate-success` | `src/routes/payment.ts:401` | `developmentOnly`, Joi, session token | Returns a valid HMAC signature computed with `RAZORPAY_KEY_SECRET`. Non-production only. |
| `POST /api/v1/payment/mock/simulate-failure` | `src/routes/payment.ts:455` | `developmentOnly`, Joi, session token | Non-production only. |
| `POST /api/v1/admin/auth/login` | `src/routes/admin.ts:74` | `loginRateLimiter` (10 failed / 15 min per IP+email), Joi, account lockout | See §3. |
| `POST /api/v1/admin/auth/refresh` | `src/routes/admin.ts:75` | Joi (10–500 chars) | 384-bit refresh token; rotation with reuse detection. Global limiter only. |
| `POST /api/v1/admin/auth/logout` | `src/routes/admin.ts:76` | Joi | Revokes the presented refresh token. |
| `POST /api/v1/queue/printers/enroll` | `src/routes/queue.ts:67` | `printerEnrollRateLimiter` 5 failed / 15 min / IP, `X-Provisioning-Token` (constant-time), Joi | Returns a new printer API key bound to the **kiosk UUID supplied in the body** — any kiosk of any organization. |
| WebSocket `ws(s)://host${WS_PATH}` (default `/api/v1/ws`) | `src/services/websocketService.ts:16` | **None** | No auth, no origin check, no rate/connection/subscription limits, default 100 MiB max message. Subscribing to a job id streams its status (`queued` + `paidAt`). Subscription bookkeeping leaks memory (`:53-59`, `:85-90`). |

## 2. Customer endpoints (session token)

| Method & path | File:line | Ownership resolution | Notes |
|---|---|---|---|
| `GET /api/v1/sessions/:sessionId` | `sessions.ts:200` | by `session_id` | Returns document metadata, job, payment summary. |
| `DELETE /api/v1/sessions/:sessionId` | `sessions.ts:238` | by `session_id` | Cancels session. |
| `POST /api/v1/sessions/:sessionId/documents` | `documents.ts:58` | by `session_id`, checked **before** multer | Multipart field `document`, 1 file, ≤10 MB, MIME allow-list from client header. Unknown session id → multer still buffers the body before 404. |
| `GET /api/v1/sessions/:sessionId/documents` | `documents.ts:94` | by `session_id` | Metadata. |
| `POST /api/v1/sessions/:sessionId/print-jobs` | `printJobs.ts:108` | by `session_id` | Joi settings; price computed server-side. |
| `GET /api/v1/sessions/:sessionId/print-jobs` | `printJobs.ts:152` | by `session_id` | |
| `GET /api/v1/print-jobs/:jobId` | `printJobs.ts:230` | job → session | UUID check first. |
| `PATCH /api/v1/print-jobs/:jobId/settings` | `printJobs.ts:320` | job → session | Locked once a payment order exists. `customRange` is an unbounded-length string (bounded by body limit). |
| `GET /api/v1/documents/:documentId` | `documentRoutes.ts:41` | document → session | |
| `GET /api/v1/documents/:documentId/preview` | `documentRoutes.ts:105` | document → session | Returns 1-hour pre-signed URLs (document + thumbnails); cached 5 min in memory. |
| `GET /api/v1/documents/:documentId/download` | `documentRoutes.ts:160` | document → session | 1-hour pre-signed URL. |
| `DELETE /api/v1/documents/:documentId` | `documentRoutes.ts:204` | document → session | Refused while a job is paid/queued/printing. |
| `POST /api/v1/print-jobs/:jobId/payment/order` | `payment.ts:72` | job → session | Creates Razorpay order priced from the locked job row. |
| `GET /api/v1/print-jobs/:jobId/payment` | `payment.ts:107` | job → session | |
| `POST /api/v1/payment/verify` | `payment.ts:182` | order (body) → session | **Unknown `orderId` passes through**; `paymentId` is then interpolated unencoded into `GET https://api.razorpay.com/v1/payments/${paymentId}` with platform credentials (`razorpayService.ts:208`) before any DB check. |
| `GET /api/v1/payment/order/:orderId` | `payment.ts:218` | order → session | |
| `GET /api/v1/payment/order/:orderId/status` | `payment.ts:336` | order → session | |
| `POST /api/v1/payment/failure` | `payment.ts:276` | order (body) → session | Only `created/attempted/pending` orders can be failed. `errorDescription` length is unbounded (stored in `print_jobs.error_message`). |
| `GET /api/v1/queue/jobs/:jobId` | `queue.ts:169` | job → session | Print progress. |

## 3. Authentication / authorization surfaces

| Surface | Mechanism | Evidence | Observations |
|---|---|---|---|
| Customer session | 32-byte random token, SHA-256 at rest, constant-time compare | `sessionAccessService.ts:27-37` | Strong. Pass-through on missing resources (see above). Session ids are `S<ms timestamp><Math.random 6 digits>` — guessable but not sufficient without the token. |
| Admin login | bcrypt, lockout 5 attempts → 15 min, uniform errors, dummy compare | `adminAuthService.ts:73-156` | 423 for locked accounts reveals existence; lockout is triggerable by anyone knowing the email; no MFA. |
| Admin access token | HS256 JWT (`JWT_SECRET`), `typ: 'admin_access'`, 15 min, claims carry role/org/perms | `adminAuthService.ts:221-260`, `:364-389` | No DB lookup per request → revocations take effect at expiry. `jwt.verify` has no explicit `algorithms` list (library default restricts to HMAC for a string secret). |
| Admin refresh token | 48 random bytes, SHA-256 at rest, rotated, reuse ⇒ revoke all | `adminAuthService.ts:268-333` | Two concurrent refreshes with the same token can both succeed (no row lock / conditional update). |
| Forced password change | `mcp` claim + `requirePasswordChanged` | `routes/admin.ts:85`, `adminAuth.ts:94-106` | |
| RBAC | role defaults + per-user grant/deny overrides; `requirePermission`, `requireSuperAdmin` | `types/admin.ts`, `adminAuth.ts:45-87` | Platform permissions not grantable to shop staff (`adminUserService.ts:329-342`). No rank check between shop roles (owner/manager/viewer) for staff management. |
| Tenant isolation | `resolveTenant` + service-level `organization_id` filters | `adminAuth.ts:119-160`; services | Routes without `resolveTenant` (`PATCH /kiosks/:id`, `POST /printers/:printerId/revoke`, `POST /pricing/lists`, `/audit/actions`, `/permissions`) scope in the controller/service or are super-admin-only — verified. |
| Printer | `X-Printer-Id` + `X-Printer-Key` (SHA-256, constant-time), revocation | `printerAuth.ts:33-65`, `printerAuthService.ts:55-82` | Job claim and status updates scoped to the printer's kiosk and held job. |
| Printer enrolment | deployment-wide `X-Provisioning-Token` | `printerAuth.ts:72-98` | Not bound to a kiosk/organization. |
| Admin proxy | `X-MPrnt-Proxy-Secret` (constant-time) lets caller set `req.ip` via `X-MPrnt-Client-IP` | `trustedProxy.ts:25-58` | Holder of the secret controls IP-keyed rate limits and audit IPs. |
| Razorpay webhook | HMAC over raw body | `paymentService.ts:240-301` | |
| Legacy `authenticate`/`authorize` | JWT with `role` claim | `src/middleware/auth.ts` | Not mounted anywhere (dead code). |

## 4. Admin surfaces (`/api/v1/admin/*`, `src/routes/admin.ts`)

All routes below line 79 require `authenticateAdmin`; all below line 85 also require `requirePasswordChanged`.

| Route(s) | Line | Guard | Data reachable |
|---|---|---|---|
| `GET /auth/me`, `POST /auth/change-password` | 81-82 | token | own profile |
| `POST/GET /organizations`, `GET/PATCH/DELETE /organizations/:id`, `POST /organizations/:id/status`, `POST /organizations/:id/kiosks` | 91-124 | super admin | all tenants |
| `GET /kiosks` | 133 | tenant + `printers:read` | kiosks |
| `POST /users` | 145 | super admin | creates shop admins (temp password in response) |
| `GET /users`, `GET /users/:id`, `GET /users/:id/permissions` | 148, 154, 190 | tenant + `staff:read` | staff |
| `PATCH /users/:id`, `DELETE /users/:id`, `POST /users/:id/reset-password`, `POST /users/:id/unlock`, `PUT /users/:id/permissions` | 161-197 | tenant + `staff:write` | staff management; reset returns a temporary password |
| `GET /permissions` | 205 | token | static catalogue |
| `GET /reports/summary`, `/reports/series`, `/reports/kiosks` | 211-225 | tenant + `reports:read` | revenue |
| `GET /reports/sessions` | 232 | tenant + `sessions:read` | job list (no filenames/IPs) |
| `GET /reports/sessions/export` | 239 | tenant + `export:data` | CSV (max 200 rows); no formula-injection neutralisation |
| `GET /printers`, `GET /attention` | 250, 256 | tenant + `printers:read` / `reports:read` | fleet health, stuck paid jobs |
| `GET /audit`, `GET /audit/actions` | 262, 269 | (tenant) + `audit:read` | audit log, scoped by principal |
| `GET /reports/organizations`, `GET /queue/status` | 278, 283 | super admin | platform metrics |
| `POST /kiosks` | 292 | super admin | |
| `PATCH /kiosks/:id` | 294 | `printers:manage`, org scope in controller | |
| `POST /printers/enroll`, `POST /printers/:printerId/rotate-key` | 309, 315 | super admin | returns printer API key |
| `POST /printers/:printerId/revoke` | 321 | `printers:manage`, org scope in controller | |
| `GET /pricing`, `GET /pricing/lists` | 331, 337 | tenant + `pricing:read` | |
| `POST /pricing/lists` | 343 | `pricing:write` (super admin only; not grantable) | sets prices for any org/kiosk |
| `GET /leads` | 353 | super admin | lead PII |
| `POST /print-jobs/:jobId/refund` | 364 | tenant + `refunds:issue` | triggers real Razorpay refund |
| `GET /api/v1/sessions` (mounted in `sessions.ts:84`) | — | admin token + password changed + super admin | all customer sessions platform-wide |

Super-admin creation is CLI-only: `npm run create-super-admin` → `scripts/create-super-admin.ts` (prints the generated password to the terminal once).

## 5. Printer (device) endpoints (`/api/v1/queue/*`, `src/routes/queue.ts`)

| Route | Line | Guard | Notes |
|---|---|---|---|
| `POST /printers/enroll` | 67 | provisioning token | see §1 |
| `POST /printers/register` | 84 | printer key, 120/min per IP+id | Pi can rename itself (any 1–255 char string) and change capabilities; name flows into admin views and CSV export. |
| `POST /heartbeat` | 103 | printer key | `printerId` forced from credentials. |
| `POST /poll` | 127 | printer key | Claims next paid job for **its kiosk**; returns pre-signed document URL (TTL `PRINTER_DOCUMENT_URL_TTL_SECONDS`, default 900 s), filename, settings. |
| `POST /jobs/:jobId/status` | 151 | printer key | Only the printer holding the job; server-owned states rejected by Joi. |

## 6. User inputs

| Input | Validation | Sinks |
|---|---|---|
| JSON bodies (all routes) | Joi with `stripUnknown` on most routes (`middleware/validate.ts`); 10 MB limit | Parameterised SQL |
| Query strings | Joi on admin report/audit/leads/session-list routes | Parameterised SQL; `LIMIT ${limit} OFFSET ${offset}` interpolated in `auditService.ts:161` (safe only because Joi coerces to integers first) |
| Path params | UUID checks on job/document ids; `sessionId` only `Joi.string()` | Parameterised SQL |
| Multipart file + filename | MIME allow-list (client-declared), size/count limits | S3 key extension (`storageService.ts:47` — unsanitised `split('.').pop()`), `documents.original_filename`, JSON responses, printer assignment |
| `customRange` | string, parsed server-side and bounded by document page count | price calculation |
| Lead form fields | Joi lengths, trimmed | DB, super-admin API |
| Printer name / capabilities / heartbeat | Joi | DB, admin dashboards, CSV export |
| WebSocket messages | `JSON.parse` only | in-memory maps |
| Webhook body | HMAC first, then `JSON.parse` | capture transaction |
| Headers: `X-Forwarded-For` (via `trust proxy 1`), `X-MPrnt-Client-IP` (with proxy secret), `User-Agent` | — | `req.ip` for rate limits, audit, `print_sessions.client_ip`, `printers.last_seen_ip` |

SQL construction review: every query uses `$n` parameters. Dynamic fragments are built only from code constants (column names, `FAILABLE_ORDER_STATUSES`, the `date_trunc` unit mapped from a fixed object, `jobFilter`, `scope` strings) — no request data is concatenated into SQL other than the Joi-validated integers above.

## 7. File uploads

- Route: `POST /api/v1/sessions/:sessionId/documents` (`src/routes/documents.ts:58`).
- Multer `memoryStorage`, `fileSize` 10 MB, `files` 1, MIME in `{application/pdf, image/png, image/jpeg, image/jpg}` (`src/middleware/upload.ts`). Field name `document`.
- No magic-byte/content verification; no antivirus; MIME from the client is stored as S3 `ContentType`.
- PDF page count via `pdf-parse` 2.4.5 / `pdfjs-dist` 5.4.296 in the request path (`documentService.ts:32-50`); background re-processing with `sharp` (thumbnails) and `pdf-parse` (`workers/documentProcessor.ts`).
- Object key `sessions/<sessionId>/<ms>-<16 hex>.<client extension>` (`storageService.ts:44-49`).
- One document per session; session must exist and be unexpired.
- `multer@1.4.5-lts.2` is deprecated upstream for known vulnerabilities fixed in 2.x.

## 8. Database access

- PostgreSQL via `pg` pool (max `DB_POOL_MAX`=20) with one credential (`src/config/database.ts`).
- Production TLS: `{ rejectUnauthorized: false }` (no certificate verification).
- Same credential used by `node-pg-migrate` (`.pgmigrate.json`) and scripts (`scripts/run-migration.ts`, `scripts/setup-kiosks.js`, `scripts/create-super-admin.ts`).
- No row-level security; tenant isolation is application-enforced.
- Background jobs perform deletes (`sessionExpiryJob.ts:97`, refresh-token pruning) under advisory locks.
- Dev tooling: Adminer on `0.0.0.0:8080` and Postgres on `0.0.0.0:5432` in `docker-compose*.yml`.

## 9. Storage

- S3 or MinIO (`S3_ENDPOINT`), static key pair, single bucket (`S3_BUCKET_NAME`, default `mprnt-documents`).
- Objects: customer originals and `-thumb.jpg` / `-thumb-page<N>.jpg` derivatives.
- Access: server-side Put/Get/Delete; clients only via pre-signed GET URLs (1 h customers, 15 min printers).
- `PutObject` sets no `ServerSideEncryption`; no ACL set (private by default).
- Deletion: originals on session expiry and explicit delete; thumbnails only on explicit delete (not on expiry).
- `storageService.getPublicUrl()` builds an unsigned public URL but is unused.
- Local compose: `mc anonymous set download myminio/mprnt-documents` makes the dev bucket world-readable (`docker-compose.yml:57`).
- Bucket policy / public-access block / versioning / lifecycle: **not in repository — verify.**

## 10. Webhooks

| Direction | Endpoint | Auth | Notes |
|---|---|---|---|
| Inbound | `POST /api/v1/payment/webhook` | Razorpay HMAC-SHA256 (`X-Razorpay-Signature`) | Handles `payment.captured`, `order.paid`; others acknowledged and ignored; unknown orders acknowledged. Signed payload amount is compared with the order. |
| Outbound | none | — | The service sends no webhooks. |

## 11. Third-party integrations

| Integration | Direction | Credential | Evidence |
|---|---|---|---|
| Razorpay Orders/Payments/Refunds API | outbound HTTPS `api.razorpay.com/v1` | Basic auth key id/secret | `razorpayService.ts:75-123`; path segments from `orderId`/`paymentId` (DB-sourced except `paymentId` on `/payment/verify`) |
| Razorpay Checkout (browser) | via frontend | public key id | `paymentController.ts:46` |
| AWS S3 / MinIO | outbound | static keys | `storageService.ts` |
| PostgreSQL (Railway) | outbound | `DATABASE_URL` | `database.ts` |
| `mprnt-admin` dashboard | inbound | admin JWT + optional proxy secret | `trustedProxy.ts` |
| Raspberry Pi client | inbound | printer key / provisioning token | `docs/RASPBERRY_PI_INTEGRATION.md` |

## 12. Network / deployment exposure

- Process listens on `0.0.0.0:${PORT}` (default 3000), HTTP only; TLS termination expected at Railway (`src/index.ts:13`). Helmet's default HSTS header is sent.
- WebSocket shares the HTTP port and path `WS_PATH`.
- `trust proxy = 1`: correct only with exactly one reverse-proxy hop — **verify on Railway**.
- Container: `node:22-alpine`, non-root UID 1001, `dumb-init`, health check on `/health` (`Dockerfile`). Build installs with `npm ci` (dev deps in builder stage only).
- `package.json` `build` script runs `npm install` (not `npm ci`) then `npm prune --production`; which build path Railway actually uses (Dockerfile vs Nixpacks) is **not determinable from the repo — verify**.
- `package.production.json` lists a different, stale dependency set (`bull`, `redis`, `axios`, `pino`) and is not referenced by the Dockerfile.
- Logs written to `logs/` inside the container (ephemeral) and stdout.
- In-memory state (rate limiters, preview cache, WebSocket subscriptions, mock orders) assumes a single instance.
- Local-only: `docker-compose.yml` publishes Postgres 5432, MinIO 9000/9001, Adminer 8080 on all interfaces with default credentials.
- No CI configuration (`.github/` absent); Husky pre-commit runs lint-staged only.

## 13. Dependencies and other externally reachable surfaces

`npm audit --omit=dev` on 2026-10-05: **6 vulnerabilities (1 critical, 3 high, 2 moderate)**

| Package | Severity | Path | Reachability |
|---|---|---|---|
| `tar` | critical | `bcrypt` → `@mapbox/node-pre-gyp` → `tar` | Install-time (native binary download), not request path |
| `@mapbox/node-pre-gyp` | high | via `bcrypt` | Install-time |
| `glob` | high | `node-pg-migrate` | CLI (migrations), not request path |
| `node-pg-migrate` | high | via `glob` | CLI |
| `aws-sdk` (v2) | moderate | direct dependency | **Not imported anywhere** — removable |
| `uuid` | moderate | direct (`printJobService.ts:1` uses `v4` only) | Advisory concerns v3/v5/v6 with a `buf` argument — not used |

Additional:
- `multer@1.4.5-lts.2` — npm deprecation notice says 1.x is affected by vulnerabilities patched in 2.x (not reported by `npm audit` at the time of review) — request path.
- `pdfjs-dist@5.4.296` (via `pdf-parse@2.4.5`), `sharp@^0.35`, `ws@8.21.3`, `express@4.22.3`, `jsonwebtoken@9.0.3` — parse untrusted input in the request path; keep current.
- `swagger-ui-express` serves static assets publicly.
- No automated dependency scanning (Dependabot/Renovate/CI) in the repository.
