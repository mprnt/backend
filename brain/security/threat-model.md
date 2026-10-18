# Threat Model — mprnt-backend

> Scope: this repository only (`mprnt-backend`, commit `dd1221b`, assessed 2026-10-05).
> The customer web frontend, the admin dashboard (`mprnt-admin`) and the Raspberry Pi
> client (`pi_client/`, excluded by `.railwayignore`) are separate codebases. They are
> modelled here only as actors and trust boundaries; their own code was not reviewed.
>
> Every statement below is based on code, configuration or files present in this
> repository. Where something depends on deployment state that the repository cannot
> show (Railway variables, S3 bucket policy, backups), it is marked
> **Potential risk requiring verification**.

Finding classes used across `/brain/security/`:

| Class | Meaning |
|---|---|
| **Confirmed vulnerability** | Exploitable as the code stands today. |
| **Security weakness** | A real flaw in an existing control; exploitation needs an extra condition. |
| **Missing control** | A protection that does not exist in the code/config at all. |
| **Potential risk requiring verification** | Depends on deployment state not visible in the repo. |
| **Recommendation** | Hardening with no concrete defect behind it. |

---

## 1. System overview

A single Node.js/Express 4 process (TypeScript, `src/index.ts`) serves:

- a REST API under `/api/v1/*` (`src/app.ts:171-180`),
- a WebSocket server on the same HTTP server at `WS_PATH` (default `/api/v1/ws`, `src/services/websocketService.ts:16`),
- Swagger UI at `/api-docs` and `/api-docs.json` (`src/config/swagger.ts`),
- background timers (session expiry, document sweep, printer reaper, daily stats) coordinated with Postgres advisory locks (`src/index.ts:24-29`, `src/utils/advisoryLock.ts`).

Data stores and external services:

| Component | Evidence |
|---|---|
| PostgreSQL (`pg` pool) | `src/config/database.ts` |
| S3 / MinIO object storage (AWS SDK v3) | `src/services/storageService.ts` |
| Razorpay REST API (raw `https` client) | `src/services/razorpayService.ts:75-123` |
| Razorpay webhooks (inbound) | `src/routes/payment.ts:243`, `src/services/paymentService.ts:240-301` |
| In-process memory cache | `src/services/cacheService.ts` |
| Winston logs to stdout + `logs/*.log` | `src/utils/logger.ts` |

Deployment evidence: `Dockerfile` (node:22-alpine, non-root user), `.railwayignore`, `.env.production` (placeholder template, tracked), `docker-compose*.yml` (local development only).

### Core business flow

1. Customer scans a kiosk QR → `POST /api/v1/sessions` (unauthenticated) → receives `sessionId` + one-time `sessionToken` (`src/controllers/sessionController.ts:74-96`).
2. Customer uploads one document (`POST /sessions/:sessionId/documents`, multipart, ≤10 MB) → stored in S3 under `sessions/<sessionId>/…`.
3. Customer creates a print job; price is computed server-side from `price_lists` (`src/services/printJobService.ts:126`, `src/services/pricingService.ts`).
4. Customer pays via Razorpay; server verifies signature (`/payment/verify`) and/or receives a signed webhook; the job is queued in the same transaction (`src/services/paymentService.ts:335-514`).
5. A Raspberry Pi printer at the kiosk polls `/api/v1/queue/poll` with its API key, receives a pre-signed S3 URL (TTL 900 s by default), prints, reports status.
6. Shop staff and platform super admins use `/api/v1/admin/*` (JWT bearer) for reports, staff, kiosks, printers, pricing, refunds and audit.
7. Expired sessions have their documents deleted from S3 and Postgres (`src/jobs/sessionExpiryJob.ts`).

---

## 2. Assets

| ID | Asset | Where | Sensitivity |
|---|---|---|---|
| A1 | Customer documents (PDF/PNG/JPEG) and image thumbnails | S3 bucket `S3_BUCKET_NAME`, keys `sessions/<sessionId>/…` and `…-thumb.jpg` | **High** — arbitrary personal documents (IDs, certificates, financial papers are typical print-shop content) |
| A2 | Document metadata (original filename, size, type, page count) | `documents` table | Medium |
| A3 | Customer session secrets (`X-Session-Token`) | Returned once; SHA-256 hash in `print_sessions.access_token_hash` | High (bearer access to A1) |
| A4 | Customer IP and user agent | `print_sessions.client_ip`, `print_sessions.user_agent` (`src/services/sessionService.ts:164`) | Medium (personal data) |
| A5 | Payment records (orders, transactions, refunds) | `payment_orders`, `payment_transactions`, `payment_refunds` | High (financial integrity) |
| A6 | Razorpay credentials (key id/secret, webhook secret) | env vars | **Critical** |
| A7 | `JWT_SECRET` (signs every admin access token) | env var | **Critical** — forging it = super admin |
| A8 | Admin accounts (bcrypt hashes, refresh-token hashes, roles, permission overrides) | `admin_users`, `admin_refresh_tokens`, `admin_permission_overrides` | High |
| A9 | Printer API keys (SHA-256 hashes) and `PRINTER_PROVISIONING_TOKEN` | `printers.api_key_hash`; env var | High (both grant access to paid customer documents) |
| A10 | `ADMIN_PROXY_SECRET` | env var, shared with `mprnt-admin` | Medium (lets the holder set the client IP the API believes) |
| A11 | Organization (shop) business data: revenue, pricing, kiosks, staff | `organizations`, `price_lists`, `kiosks`, `print_jobs`, reports | Medium–High (tenant confidentiality) |
| A12 | Audit log | `audit_logs` | Medium (integrity of forensic record) |
| A13 | Leads from the marketing contact form (name, email, phone, company, message, IP, UA) | `leads` (`src/services/leadService.ts:53`) | Medium (personal data) |
| A14 | AWS / S3 credentials | env vars | **Critical** (full bucket access) |
| A15 | Database credentials (`DATABASE_URL` / `DB_*`) | env vars | **Critical** |
| A16 | Service availability (kiosks must accept payments and print) | runtime | High (revenue) |

---

## 3. Actors

| Actor | Trust | How they authenticate | Evidence |
|---|---|---|---|
| Anonymous internet user | Untrusted | none | Public routes in `src/routes/public.ts`, `sessions.ts` (POST), `setup.ts` (GET), webhook, health, docs, WebSocket |
| Customer (kiosk user) | Untrusted, scoped to own session | `X-Session-Token` (256-bit random, hashed) | `src/middleware/sessionAuth.ts`, `src/services/sessionAccessService.ts` |
| Raspberry Pi printer | Semi-trusted device, scoped to own kiosk | `X-Printer-Id` + `X-Printer-Key` | `src/middleware/printerAuth.ts:33-65` |
| Device installer holding the provisioning token | Trusted operator | `X-Provisioning-Token` (deployment-wide) | `src/middleware/printerAuth.ts:72-98` |
| Shop viewer / manager / owner | Trusted within own organization | Admin JWT (15 min) + refresh token (7 days) | `src/types/admin.ts:37-75`, `src/middleware/adminAuth.ts` |
| Platform super admin | Highly trusted, all tenants | Admin JWT; account created only via CLI | `scripts/create-super-admin.ts` |
| Admin dashboard server (`mprnt-admin`) | Trusted relay | `X-MPrnt-Proxy-Secret` (only to assert client IP) | `src/middleware/trustedProxy.ts` |
| Razorpay | Trusted third party | HMAC-SHA256 webhook signature; HTTPS + Basic auth outbound | `src/services/paymentService.ts:244-250`, `src/services/razorpayService.ts:76` |
| Operator with shell/Railway access | Fully trusted | Infrastructure access | `scripts/*`, env vars |

---

## 4. Trust boundaries

```
 Internet ──(TB1)──► Railway edge / TLS ──(TB2)──► Express app (single process)
   │                                                 │  ├─(TB5)─► PostgreSQL
   │ customer browser (X-Session-Token)              │  ├─(TB6)─► S3 / MinIO
   │ Raspberry Pi (X-Printer-Key)                    │  └─(TB7)─► api.razorpay.com
   │ mprnt-admin server (Bearer JWT + proxy secret)  │
   │ Razorpay webhooks (HMAC)                        │
   │                                                 │
   └──(TB3)── pre-signed S3 URLs fetched directly by browser / Pi ──► S3
 Shop A admin ──(TB4: tenant boundary, enforced in app code)── Shop B data
```

| ID | Boundary | Enforcement in this repo |
|---|---|---|
| TB1 | Internet → platform edge | Not in repo (Railway). `app.set('trust proxy', 1)` assumes exactly one proxy hop (`src/app.ts:26`). |
| TB2 | Edge → application | Helmet, CORS allow-list, global rate limiter, JSON body limit 10 MB, per-route auth middleware (`src/app.ts:29-56`). WebSocket upgrades bypass all Express middleware. |
| TB3 | Application → direct client access to S3 | Pre-signed GET URLs: 3600 s for customers (`src/services/documentService.ts:238`, `:309`), `PRINTER_DOCUMENT_URL_TTL_SECONDS` (default 900 s) for printers (`src/services/queueService.ts:394-397`). |
| TB4 | Tenant isolation (shop ↔ shop, shop ↔ platform) | `resolveTenant` (`src/middleware/adminAuth.ts:119-160`) plus organization filters inside each service; platform-only permissions cannot be granted to shop staff (`src/services/adminUserService.ts:329-342`). Single shared database, no row-level security. |
| TB5 | App → PostgreSQL | Parameterised queries throughout; TLS in production **without certificate verification** (`src/config/database.ts:35`). Single DB credential for runtime and migrations (`.pgmigrate.json`). |
| TB6 | App → S3 | Static access key pair from env (`src/services/storageService.ts:22-30`); no SSE parameter on `PutObject` (`:56-61`). |
| TB7 | App → Razorpay | HTTPS with Basic auth from env (`src/services/razorpayService.ts:75-123`); host fixed to `api.razorpay.com`, path built from request data (see T-07). |

---

## 5. Entry points (summary — full list in `attack-surface.md`)

| Entry point | Auth | Notes |
|---|---|---|
| `POST /api/v1/sessions` | none, 10/min/IP | Creates session + secret |
| Session-scoped customer routes (documents, print jobs, payment order/verify/status, queue job status) | `X-Session-Token` | Pass-through when the referenced resource does not exist (`src/middleware/sessionAuth.ts:32-35`) |
| `POST /api/v1/payment/webhook` | Razorpay HMAC over raw body | 503 if `RAZORPAY_WEBHOOK_SECRET` unset |
| `POST /api/v1/queue/printers/enroll` | provisioning token, 5 failures/15 min/IP | Issues a printer API key for **any** kiosk UUID |
| `/api/v1/queue/{register,heartbeat,poll,jobs/:id/status}` | printer key | 120 req/min per IP+printer id |
| `/api/v1/admin/auth/{login,refresh,logout}` | none (credentials in body) | Login limiter 10 failed/15 min per IP+email |
| `/api/v1/admin/*` (everything else) | Admin JWT + permission/tenant checks | |
| `POST /api/v1/public/leads`, `GET /api/v1/public/pricing`, `GET /api/v1/setup/kiosks` | none | |
| `POST /api/v1/setup/kiosks`, `/api/v1/payment/mock/*` | blocked only when `NODE_ENV === 'production'` | |
| WebSocket `WS_PATH` | **none** | |
| `/health`, `/health/ready`, `/api-docs`, `/api-docs.json`, `/` | none | |

---

## 6. Existing security mechanisms (verified in code)

These were confirmed before identifying gaps:

1. **Customer session secrets** — 32 random bytes, only SHA-256 stored, constant-time compare, required on every session/job/document/order route (`src/services/sessionAccessService.ts:27-37`; routes in `src/routes/{sessions,documents,documentRoutes,printJobs,payment,queue}.ts`). Tested in `tests/routes/sessionAccess.test.ts`.
2. **Admin authentication** — bcrypt (rounds from `BCRYPT_ROUNDS`, default 12); uniform "Invalid email or password" with a dummy bcrypt compare for unknown accounts; 5-failure / 15-minute lockout evaluated in SQL; failed sign-ins audited; refresh tokens are 48 random bytes, stored hashed, rotated on use, and replay of a revoked token revokes all of that admin's sessions (`src/services/adminAuthService.ts`).
3. **Forced password change** — temporary passwords (CLI- or admin-generated) set `must_change_password`; every admin route after `/auth/me` and `/auth/change-password` returns 403 until changed (`src/routes/admin.ts:85`, `src/middleware/adminAuth.ts:94-106`).
4. **RBAC + tenant isolation** — role → permission sets with grant/deny overrides; `resolveTenant` derives scope from the token, rejects foreign `organizationId` for shop staff; services re-apply organization filters (`adminUserService`, `fleetService.updateKiosk`, `printerOrganization`, `refundService.refundJob`, `auditService.list`, `dashboardService.scope`). Platform permissions (`orgs:*`, `pricing:write`, `platform:reports`, `audit:read_all`) cannot be granted to shop staff. Super admins cannot be created, edited, reset or deleted over HTTP.
5. **Printer credentials** — per-printer 256-bit keys, SHA-256 at rest, constant-time compare, identical error for unknown printer vs wrong key, revocation and rotation, job claim/updates scoped to the printer's own kiosk and held job (`src/services/printerAuthService.ts`, `src/services/queueService.ts:292-432`, `:456-490`).
6. **Payments** — server-side pricing; amount fixed under row lock; Razorpay signature verified with constant-time compare and payment fetched from Razorpay to confirm `order_id` and `captured` (`src/services/razorpayService.ts:188-230`); webhook HMAC over the exact raw body (`src/app.ts:45-55`, `src/services/paymentService.ts:244-250`); idempotent capture with `FOR UPDATE`; amount mismatch and refunded jobs never queue; client-reported failures can only fail open orders.
7. **Production start-up guard** — refuses to start without `PRINTER_PROVISIONING_TOKEN`, a non-default `JWT_SECRET`, an `rzp_live_` key (or `rzp_test_` with `ALLOW_TEST_PAYMENTS=true`) and `RAZORPAY_KEY_SECRET` (`src/config/environment.ts:196-227`; tested in `tests/config/environment.test.ts`).
8. **Dev-only endpoints** — `POST /setup/kiosks` and mock payment simulation return 404 in production (`src/routes/setup.ts:18-25`, `src/routes/payment.ts:26-33`).
9. **HTTP hardening** — `helmet()` defaults, CORS allow-list from `CORS_ORIGIN`, global per-IP rate limit, generic 500 body (`src/middleware/errorHandler.ts:66-76`).
10. **Audit log** — admin actions, sign-ins, failed sign-ins, printer enrol/rotate/revoke; shop view limited to its own staff's rows (`src/services/auditService.ts:132-140`).
11. **Secrets hygiene in code** — keys/passwords returned once and never logged (only key prefix), `.env`/`*.local` git-ignored, `.env*` docker-ignored; no real secrets found in git history (see `secrets.md`).
12. **Data minimisation** — documents deleted from S3 when sessions expire (`src/jobs/sessionExpiryJob.ts:58-98`); payment rows kept (migration 013).
13. **Container** — multi-stage build, runs as non-root UID 1001 (`Dockerfile:28-45`).

---

## 7. Threats, attack scenarios and risk

Likelihood and impact are rated Low / Medium / High; severity follows the combination and the stated preconditions. IDs are shared with `security-checklist.md`.

### T-01 Forged super-admin token via default JWT secret
- **Class:** Security weakness (+ Potential risk requiring verification of `NODE_ENV` in deployment)
- **STRIDE:** Spoofing / Elevation of privilege
- **Scenario:** The service is started with `NODE_ENV` unset or set to anything other than the exact string `production` (e.g. `staging`, `prod`). `JWT_SECRET` falls back to the hard-coded `change_this_secret` (`src/config/environment.ts:106`) and the start-up guard is skipped (`:211`). An attacker signs `{typ:'admin_access', role:'super_admin', perms:[…]}` with that string and calls any `/api/v1/admin/*` route. The same misconfiguration also enables `POST /setup/kiosks`, `/payment/mock/*` and disables DB TLS.
- **Impact:** High (full platform takeover: all tenants, pricing, staff, printer keys). **Likelihood:** Low (requires mis-set `NODE_ENV`; `.env.production` sets it). **Severity: High (conditional).**
- **Existing mitigations:** production guard rejects the default; `.env.production` template sets `NODE_ENV`.
- **Missing mitigations:** fail closed regardless of `NODE_ENV` (no default secret at all); allow-list dev endpoints by explicit flag instead of `!== 'production'`.

### T-02 Rogue printer enrolment with the shared provisioning token
- **Class:** Security weakness
- **STRIDE:** Spoofing / Information disclosure
- **Scenario:** `PRINTER_PROVISIONING_TOKEN` is one deployment-wide secret given to installers (`docs/RASPBERRY_PI_INTEGRATION.md:41`, `:442-450`). Anyone holding it can call `POST /api/v1/queue/printers/enroll` with **any** kiosk UUID (`src/validators/queueValidator.ts:22-35`; no tenant binding in `src/services/fleetService.ts:133-190`) and obtain a valid printer key. That printer then competes in `/queue/poll` for the kiosk's paid jobs and receives pre-signed URLs to customers' documents.
- **Impact:** High (customer document theft at any shop, failed prints). **Likelihood:** Low–Medium (token leak via an installer, a Pi image, shell history or docs). **Severity: Medium.**
- **Existing mitigations:** constant-time compare, 5 failed attempts/15 min/IP (`src/middleware/rateLimiter.ts:47-54`), audit row `printer.enrolled`, printer id uniqueness, admin can revoke, super admins can enrol from the dashboard instead.
- **Missing mitigations:** per-kiosk or single-use enrolment codes; approval step before a newly enrolled printer receives jobs; alert on device enrolment.

### T-03 Unauthenticated WebSocket resource exhaustion / job-status disclosure
- **Class:** Confirmed vulnerability
- **STRIDE:** Denial of service / Information disclosure
- **Scenario:** The WebSocket server (`src/services/websocketService.ts:16`) attaches directly to the HTTP server, so it is outside Express rate limiting, CORS and auth. Any client can connect, send `{"type":"subscribe","jobId":…}` repeatedly with arbitrary ids. Each subscribe adds an entry to `subscriptions` but `clients` keeps only the last job id (`:53-59`), so on disconnect only the last subscription is removed (`:85-90`) — the rest leak permanently. `ws` 8 defaults to a 100 MiB `maxPayload`, and no connection, message-rate or subscription limits exist. Anyone who learns a job UUID also receives its status/payment-time broadcasts without a session token.
- **Impact:** Medium (process memory growth → crash/restart of the only API instance; minor status disclosure). **Likelihood:** Medium (no authentication needed). **Severity: Medium.**
- **Existing mitigations:** job ids are random UUIDv4; broadcasts contain only status and `paidAt`.
- **Missing mitigations:** require `X-Session-Token`-equivalent proof on subscribe; set `maxPayload`; cap subscriptions per socket and connections per IP; fix the per-client subscription bookkeeping; origin check.

### T-04 Outbound Razorpay API calls with attacker-controlled path, reachable without a valid session
- **Class:** Confirmed vulnerability
- **STRIDE:** Tampering / Denial of service
- **Scenario:** `POST /api/v1/payment/verify` validates only that `orderId`, `paymentId`, `signature` are strings (`src/validators/paymentValidator.ts:10-21`). `sessionTokenForOrder` passes the request through when the `orderId` does not exist (`src/middleware/sessionAuth.ts:32-35`), requiring only that *some* `X-Session-Token` header is present. With a live/test Razorpay key, `verifyPayment` then performs `GET https://api.razorpay.com/v1/payments/${paymentId}` with the platform's Basic-auth credentials (`src/services/razorpayService.ts:208`) before any database check. `paymentId` is interpolated unencoded, so an attacker controls the path suffix/query within the Razorpay v1 API, and can drive unlimited authenticated calls (bounded only by the global 100/min/IP limiter).
- **Impact:** Medium (exhaust Razorpay API rate limits → genuine payment verification fails; error/branch differences act as a small oracle). **Likelihood:** Medium. **Severity: Medium.**
- **Existing mitigations:** signature must still match (HMAC with secret) before anything is recorded; Razorpay errors become a generic 500; capture requires a DB order.
- **Missing mitigations:** strict format validation for Razorpay ids (`^pay_[A-Za-z0-9]+$`, `^order_[A-Za-z0-9]+$`); `encodeURIComponent`; check the order exists and belongs to the session *before* calling Razorpay; reject (not pass through) unknown resources on mutating routes.

### T-05 Intra-tenant privilege escalation / account takeover via `staff:write`
- **Class:** Security weakness
- **STRIDE:** Elevation of privilege
- **Scenario:** Any admin holding `staff:write` (owners by default; any shop role if an owner grants it as an override) can, for any non-super-admin in the same org including other owners and themselves: reset the password and receive the temporary password in the response (`src/services/adminUserService.ts:250-273`, `src/controllers/adminController.ts:268-284`), change role to `owner` (`:173-218`), and grant themselves any shop permission (`:311-368`). There is no actor-vs-target role hierarchy check (only "cannot delete yourself").
- **Impact:** Medium (takeover of a co-owner account, refunds, staff control — within one tenant). **Likelihood:** Low (requires a malicious owner or an over-granted manager). **Severity: Medium.**
- **Existing mitigations:** tenant scoping on all staff routes; super admins untouchable; all actions audited; target sessions revoked.
- **Missing mitigations:** role-rank rule (cannot modify equal/higher roles or self role), require re-authentication for password resets, deliver reset passwords out of band.

### T-06 Stale admin access after revocation
- **Class:** Security weakness
- **STRIDE:** Elevation of privilege
- **Scenario:** Access tokens are verified by signature only and carry permissions as claims (`src/services/adminAuthService.ts:364-389`). Deactivation, deletion, role/permission change, password reset and organization suspension revoke refresh tokens (`adminUserService.ts:213-215`, `:242`, `:269`, `:361`; `organizationService.ts:182-190`) but an already-issued access token keeps working until expiry (`ADMIN_ACCESS_TOKEN_TTL`, default 15 min).
- **Impact:** Medium. **Likelihood:** Low. **Severity: Low.** (Design trade-off documented in code.)
- **Missing mitigations:** token version / `password_changed_at` check, or a short deny-list checked in `authenticateAdmin`.

### T-07 Database connection interception
- **Class:** Security weakness
- **STRIDE:** Information disclosure / Tampering
- **Scenario:** In production the pool uses `ssl: { rejectUnauthorized: false }` (`src/config/database.ts:35`), so the server certificate is not verified. An attacker on the network path between the app and Postgres can impersonate the database and capture credentials and all data.
- **Impact:** High. **Likelihood:** Low (requires network position; depends on Railway's private networking). **Severity: Medium.**
- **Missing mitigations:** verify the server certificate (CA bundle) or use a private network that is documented as such.

### T-08 Customer document exposure or retention
- **Class:** Security weakness + Potential risk requiring verification
- **Scenarios:**
  1. Image thumbnails (`<s3_key>-thumb.jpg`, `src/workers/documentProcessor.ts:67-68`) are **not** deleted when a session expires — only `doc.s3_key` is (`src/jobs/sessionExpiryJob.ts:76-80`). Thumbnails of customers' images persist indefinitely.
  2. Pre-signed customer URLs are valid for 1 hour (`src/services/documentService.ts:238`, `:309`) and are cached in memory for 5 minutes (`:345`); anyone who obtains the URL can download the file.
  3. Bucket policy, public-access block and encryption-at-rest are not codified; `PutObject` sets no `ServerSideEncryption` (`src/services/storageService.ts:56-61`). The local compose file makes the dev bucket anonymously downloadable (`docker-compose.yml:57`).
- **Impact:** High (sensitive personal documents). **Likelihood:** Low–Medium. **Severity: Medium.**
- **Existing mitigations:** random object keys (`crypto.randomBytes(8)` + timestamp), originals deleted on expiry, private objects by default (no ACL set), short printer URL TTL.

### T-09 Malicious upload content
- **Class:** Security weakness
- **STRIDE:** Denial of service / Tampering
- **Scenario:** Uploads are accepted based on the client-declared MIME type (`src/middleware/upload.ts:10-23`); no magic-byte check, no malware scan (`ENABLE_FILE_VIRUS_SCAN` in `.env.example` is not read by any code). PDFs are parsed with `pdf-parse`/`pdfjs-dist` inside the request (`src/services/documentService.ts:32-50`) and again in the background; images are processed by `sharp`. The object-key extension comes straight from the client filename (`src/services/storageService.ts:47`). A crafted file can consume CPU on the single process or deliver malware to the print-shop Pi/CUPS stack.
- **Impact:** Medium. **Likelihood:** Low–Medium. **Severity: Low–Medium.**
- **Existing mitigations:** 10 MB / 1-file limit, MIME allow-list, session token required, one document per session, rate limits.

### T-10 Admin credential attacks and account lockout abuse
- **Class:** Security weakness
- **Scenario:** Anyone who knows an admin email can lock that account for 15 minutes with 5 wrong passwords (`src/services/adminAuthService.ts:45-46`, `:184-202`); the login limiter keys on IP+email (`src/routes/admin.ts:49-58`), so attempts from several IPs are not throttled per account. The 423 response for a locked account confirms the address exists. No MFA exists for any role, including super admin.
- **Impact:** Medium (dashboard DoS for a shop; super admin compromise would be catastrophic without MFA). **Likelihood:** Low–Medium. **Severity: Medium.**
- **Existing mitigations:** bcrypt, lockout, uniform errors for unknown/wrong password, failed-attempt auditing visible to the affected shop, 12-char minimum on new passwords.

### T-11 Free printing via test payment mode in production
- **Class:** Potential risk requiring verification
- **Scenario:** `ALLOW_TEST_PAYMENTS=true` lets production run with an `rzp_test_` key (`src/config/environment.ts:142`, `:200-202`, `:216-226`). In Razorpay test mode anyone can complete checkout with published test instruments; the webhook/verify path then queues real print jobs.
- **Impact:** Medium (revenue loss, paper/toner). **Likelihood:** High *if* the flag is still set. **Severity: Medium (conditional).**
- **Existing mitigations:** loud start-up warning; flag is opt-in and documented as "remove at launch".

### T-12 Client-IP spoofing to bypass rate limits / poison audit IPs
- **Class:** Potential risk requiring verification
- **Scenario:** `trust proxy` is `1` (`src/app.ts:26`). If the deployment has zero or more than one proxy hop, `req.ip` comes from attacker-controlled `X-Forwarded-For`, defeating every IP-keyed limiter (global, session creation, login, enrolment, leads) and corrupting audit IPs. Separately, any holder of `ADMIN_PROXY_SECRET` can set `req.ip` arbitrarily via `X-MPrnt-Client-IP` (`src/middleware/trustedProxy.ts:51-55`).
- **Impact:** Medium. **Likelihood:** Low. **Severity: Low–Medium.**

### T-13 Stored content rendered by other apps (XSS / CSV injection)
- **Class:** Potential risk requiring verification (XSS) + Security weakness (CSV)
- **Scenario:** User- or device-controlled strings are stored and returned as JSON: document `original_filename`, lead fields, printer `name` (from the Pi, `src/validators/queueValidator.ts:42`), kiosk/org names. This API returns JSON only (no HTML rendering), so XSS depends on how the customer frontend and `mprnt-admin` render them (not in this repo). The CSV export escapes quotes/commas/newlines but does not neutralise leading `=`, `+`, `-`, `@` (`src/services/dashboardService.ts:607-610`); a printer name such as `=HYPERLINK(…)` executes as a formula when a shop owner opens the export in a spreadsheet.
- **Impact:** Medium. **Likelihood:** Low. **Severity: Low.**

### T-14 Resource-exhaustion via public endpoints
- **Class:** Security weakness
- **Scenario:** 10 MB JSON and url-encoded bodies are accepted on every route including unauthenticated ones (`src/app.ts:45-56`). Multer buffers uploads in memory (`src/middleware/upload.ts:26`), and for a non-existent session id the session-token check passes through, so up to 10 MB is read before the 404 (`src/routes/documents.ts`, `src/middleware/sessionAuth.ts:32-35`). Sessions are creatable at 10/min/IP and each allows a 10 MB stored upload until expiry (15 min). Rate-limit state is in process memory.
- **Impact:** Medium (single instance). **Likelihood:** Medium. **Severity: Low–Medium.**

### T-15 Supply-chain / dependency vulnerabilities
- **Class:** Security weakness
- **Evidence:** `npm audit --omit=dev` (2026-10-05): 1 critical (`tar` via `bcrypt` → `@mapbox/node-pre-gyp`, install-time), 3 high (`glob` via `node-pg-migrate`, `tar`, `@mapbox/node-pre-gyp`), 2 moderate (`aws-sdk` v2, `uuid`). `multer@1.4.5-lts.2` is marked deprecated on npm with the notice that 1.x "is impacted by a number of vulnerabilities, which have been patched in 2.x". `aws-sdk` v2 is a production dependency but is not imported anywhere in `src/` or `scripts/`.
- **Impact:** Medium. **Likelihood:** Low–Medium. **Severity: Medium.**

### T-16 Secrets exposure
- See `secrets.md`. No real secret was found in tracked files or git history. Local plaintext production secrets file and the tracked `.env.production` template are the notable items. **Severity: Low.**

### T-17 Repudiation / detection gaps
- **Class:** Missing control
- **Scenario:** Audit writes are best-effort and swallowed on failure (`src/services/auditService.ts:91-93`); logs go to stdout and container-local files (`src/utils/logger.ts`); `SENTRY_DSN`/`NEW_RELIC_*` in `.env.example` are not read by any code. Customer-side actions (uploads, payments) are only in application logs, not the audit table. No alerting exists for enrolment, lockouts, cross-tenant attempts (`logger.warn('Cross-tenant access attempt')`) or webhook signature failures.
- **Severity: Low–Medium.**

---

## 8. Risk register (summary)

| ID | Threat | Class | Severity |
|---|---|---|---|
| T-01 | Default `JWT_SECRET` + `NODE_ENV`-only guards | Weakness / verify | **High (conditional)** |
| T-02 | Shared provisioning token → rogue printer on any kiosk | Weakness | Medium |
| T-03 | Unauthenticated WebSocket, unbounded subscriptions/payload | **Confirmed vulnerability** | Medium |
| T-04 | Unvalidated `paymentId` in outbound Razorpay call, pass-through auth | **Confirmed vulnerability** | Medium |
| T-05 | No role hierarchy for `staff:write` holders | Weakness | Medium |
| T-07 | DB TLS without certificate verification | Weakness | Medium |
| T-08 | Thumbnails never deleted; storage controls not codified | Weakness / verify | Medium |
| T-10 | Lockout abuse, no MFA | Weakness / missing control | Medium |
| T-11 | `ALLOW_TEST_PAYMENTS` in production | Verify | Medium (conditional) |
| T-15 | Vulnerable/deprecated dependencies | Weakness | Medium |
| T-09 | Upload content trust | Weakness | Low–Medium |
| T-12 | Proxy hop / proxy-secret IP spoofing | Verify | Low–Medium |
| T-14 | Body/upload resource exhaustion | Weakness | Low–Medium |
| T-17 | Detection and audit gaps | Missing control | Low–Medium |
| T-06 | Access token valid after revocation (≤15 min) | Weakness | Low |
| T-13 | Stored strings → XSS elsewhere; CSV formula injection | Verify / weakness | Low |
| T-16 | Secrets handling | See `secrets.md` | Low |

## 9. Out of scope / not assessed

- `mprnt-admin`, the customer frontend and `pi_client` source code.
- Railway project settings, networking, TLS termination, Postgres backups and S3 bucket policy (not represented in the repository).
- Dynamic testing; this is a static, evidence-based review.
