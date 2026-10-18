# Security Checklist — mprnt-backend

> Project-specific checklist, assessed against commit `dd1221b` on 2026-10-05.
> Status legend: **[x]** in place (verified in code) · **[~]** partial / has a weakness ·
> **[ ]** missing · **[?]** depends on deployment — requires verification.
> Threat IDs (T-xx) refer to `threat-model.md`; secret findings (F-x) to `secrets.md`.

---

## Part A — Checklist

### 1. Authentication
- [x] Customers authenticate per session with a 256-bit `X-Session-Token`, hashed at rest, constant-time compared (`src/services/sessionAccessService.ts:27-37`).
- [x] Every customer route that touches a session, job, document or order requires the token (`src/routes/{sessions,documents,documentRoutes,printJobs,payment,queue}.ts`).
- [~] Missing-resource requests pass the token check with any header value (`src/middleware/sessionAuth.ts:32-35`) — exploited by T-04 and T-14.
- [x] Admin passwords hashed with bcrypt (cost `BCRYPT_ROUNDS`, default 12).
- [x] Uniform error + dummy bcrypt for unknown emails (`adminAuthService.ts:96-102`).
- [x] Account lockout after 5 failures for 15 min, evaluated in SQL (`adminAuthService.ts:45-46`, `:184-202`).
- [~] Lockout can be triggered by anyone who knows an email; 423 reveals that the account exists (T-10).
- [ ] MFA for admins, in particular super admins (T-10).
- [x] Temporary passwords are random, shown once, and force a change before any other admin route (`routes/admin.ts:85`).
- [x] New passwords ≥ 12 chars and must differ from current (`validators/adminValidator.ts:25-39`).
- [ ] Breached-password / common-password check.
- [x] Super admins can only be created from the CLI (`scripts/create-super-admin.ts`); never over HTTP.
- [x] Printers authenticate with per-device 256-bit keys, hashed, revocable, rotatable (`printerAuthService.ts`).
- [~] Printer enrolment uses one deployment-wide provisioning token valid for any kiosk (T-02).
- [x] Provisioning token compared in constant time and rate-limited (`printerAuth.ts:20-24`, `rateLimiter.ts:47-54`).

### 2. Authorization / RBAC
- [x] Role → permission defaults with grant/deny overrides; deny wins (`types/admin.ts:84-98`).
- [x] Platform permissions cannot be granted to shop staff (`adminUserService.ts:329-342`).
- [x] Super-admin accounts cannot be modified, reset, overridden or deleted over HTTP.
- [x] Tenant scope derived from the token, foreign `organizationId` rejected for shop staff and logged (`adminAuth.ts:119-160`).
- [x] Services re-apply `organization_id` filters (staff, kiosks, printers, refunds, audit, reports, pricing reads) — verified per route in `attack-surface.md` §3–4.
- [x] Printer job claim/status updates restricted to the printer's own kiosk and held job (`queueService.ts:292-432`, `:456-490`).
- [~] No rank rules among shop roles: any `staff:write` holder can reset another owner's password (and receive it), change own role, grant self shop permissions (T-05).
- [ ] Database-level isolation (row-level security or per-tenant roles) — isolation is application-only.

### 3. Session / token security
- [x] Admin access tokens short-lived (15 min default) and typed (`typ: 'admin_access'`).
- [x] Refresh tokens random (384-bit), hashed, rotated, reuse ⇒ revoke all sessions.
- [x] Refresh tokens revoked on password change, reset, role change, deactivation, delete, permission override, org suspension.
- [~] Access tokens are not revocable before expiry (T-06).
- [~] Concurrent refresh with the same token is not serialised (`adminAuthService.ts:268-333` — no `FOR UPDATE` / `WHERE revoked_at IS NULL` on the rotation update).
- [~] `jwt.verify` does not pin `algorithms` (library default limits HMAC secrets to HS*; low risk).
- [ ] Fail-closed `JWT_SECRET` in every environment — currently a hard-coded fallback outside production (T-01 / F-1).
- [x] Customer sessions expire after 15 min and are swept every minute (`sessionService.ts:78-82`, `jobs/sessionExpiryJob.ts`).
- [x] No cookies are used anywhere (bearer/header tokens only).

### 4. Input validation
- [x] Joi schemas with `stripUnknown` on almost every body/query/param (`middleware/validate.ts`, `validators/*`).
- [x] UUID validation before DB lookups on job/document ids.
- [~] Razorpay ids (`orderId`, `paymentId`, `signature`) only checked as non-empty strings (`validators/paymentValidator.ts:10-21`) (T-04).
- [~] Unbounded strings: `customRange`, `errorDescription` on `/payment/failure`, `kioskId` on session creation, `sessionId` params.
- [~] Uploaded file type trusted from the client `Content-Type` part; extension from client filename used in the S3 key (T-09).
- [ ] WebSocket message schema/size validation (T-03).

### 5. Injection
- [x] All SQL uses `$n` parameters; dynamic fragments come only from code constants (reviewed every `${…}` in `src/services`, `src/controllers`, `src/jobs`).
- [~] `LIMIT ${limit} OFFSET ${offset}` interpolated in `auditService.ts:161` — safe only because Joi converts to integers first.
- [x] No shell execution, `eval`, template rendering or dynamic `require` of request data in `src/`.
- [~] Outbound HTTP path built from unencoded `paymentId` (`razorpayService.ts:208`) — request-path injection within `api.razorpay.com` (T-04).
- [~] CSV export does not neutralise formula prefixes (`dashboardService.ts:607-610`) (T-13).
- [x] S3 key prefix fixed to `sessions/<sessionId>/` and object names randomised.

### 6. XSS / CSRF
- [x] API returns JSON only; Helmet sets `X-Content-Type-Options: nosniff` and a default CSP.
- [x] CSRF not applicable: no cookies or ambient credentials; all auth via custom headers.
- [?] Stored strings (filenames, lead fields, printer/kiosk/org names, audit details) must be output-encoded by the customer frontend and `mprnt-admin` (not in this repo) (T-13).
- [~] Uploaded objects served from S3 with the client-declared `Content-Type`; restricted to the PDF/PNG/JPEG allow-list.

### 7. API security
- [x] Generic 500 responses; stack traces only in logs.
- [x] Dev-only routes return 404 in production (`routes/setup.ts:18-25`, `routes/payment.ts:26-33`).
- [~] Dev-only gating is `NODE_ENV === 'production'` (deny-list) — any other value exposes `POST /setup/kiosks` and mock payments (T-01).
- [~] `/api-docs` and `/api-docs.json` public in every environment; description states "no authentication required" (inaccurate).
- [~] `/health` discloses `NODE_ENV` and uptime.
- [x] Payment amounts computed server-side, locked under row locks; amount mismatch never queues a job.
- [x] Razorpay signature and captured status verified against the Razorpay API; webhook HMAC on raw body; idempotent capture.
- [ ] Order-exists/ownership check before calling Razorpay in `/payment/verify` (T-04).

### 8. Rate limiting / abuse
- [x] Global per-IP limiter (default 100/min).
- [x] Session creation 10/min/IP; leads 5/15 min/IP + honeypot; login 10 failed/15 min per IP+email; enrolment 5 failed/15 min/IP; printers 120/min per IP+id.
- [~] Limiters use the in-memory store — reset on restart, per instance only.
- [~] All IP-keyed limits rely on `trust proxy = 1` being correct (T-12).
- [ ] WebSocket connections/messages/subscriptions are not limited (T-03).
- [ ] Per-account (cross-IP) login throttling.
- [~] `sessionOperationRateLimiter` exists but is not mounted anywhere (`middleware/rateLimiter.ts:57-68`).
- [~] 10 MB JSON/urlencoded body limit on every route, including unauthenticated ones (`app.ts:45-56`).

### 9. File uploads
- [x] Size 10 MB, 1 file, MIME allow-list (`middleware/upload.ts`).
- [x] Session token checked before multer for existing sessions.
- [~] Unknown session ids are still buffered by multer before the 404.
- [ ] Magic-byte / content-type sniffing.
- [ ] Malware scanning (`ENABLE_FILE_VIRUS_SCAN` exists only in `.env.example`).
- [~] PDF parsing happens inside the request on the single Node process (CPU-heavy untrusted input).
- [~] Filename extension used unsanitised in the S3 key (`storageService.ts:47`).
- [~] `multer@1.4.5-lts.2` deprecated with known vulnerabilities fixed in 2.x.

### 10. Database security
- [x] Parameterised queries; transactions with row locks for money paths.
- [x] Financial rows protected from cascade deletes (migration `013_stop_financial_cascade_delete.sql`).
- [~] TLS without certificate verification in production (`config/database.ts:35`) (F-7 / T-07).
- [ ] Separate least-privilege DB roles for runtime vs migrations.
- [ ] Row-level security for tenant data.
- [x] Customer IP/UA not exposed through admin session listings.

### 11. Secrets
- [x] No real secrets in tracked files or git history (pattern + placeholder scan; see `secrets.md` §5).
- [x] `.env`, `*.local`, logs ignored by git; `.env*` excluded from Docker context.
- [x] Generated credentials (session, printer, refresh, temp passwords) shown once and stored hashed.
- [ ] No hard-coded fallback secrets (F-1).
- [~] Production start-up check omits `RAZORPAY_WEBHOOK_SECRET`, AWS and DB credentials (F-2).
- [?] Local plaintext production secrets file should be deleted (F-3).
- [~] Tracked `.env.production` template is stale and named like a real env file (F-4).
- [ ] Secret manager / rotation runbook.

### 12. Encryption
- [?] TLS in transit for clients — terminated by Railway; app listens on HTTP (`src/index.ts:13`). Helmet sends HSTS.
- [~] DB TLS without verification (F-7).
- [x] Razorpay API over HTTPS with Node's default certificate verification.
- [?] S3 encryption at rest — no `ServerSideEncryption` on `PutObject`; depends on bucket default.
- [x] Passwords bcrypt; tokens/keys SHA-256 (adequate for 256/384-bit random secrets).
- [ ] Field-level encryption for customer PII (IP, UA, lead data) — none.

### 13. CORS
- [x] Explicit allow-list from `CORS_ORIGIN` (comma-separated), no wildcard default (`config/environment.ts:116-119`).
- [~] `CORS_CREDENTIALS=true` in `.env.example` although no cookies are used (unnecessary).
- [?] Production `CORS_ORIGIN` value — tracked template holds a placeholder; verify Railway.
- [ ] CORS/Origin enforcement on WebSocket upgrades.

### 14. Dependency security
- [ ] Resolve `npm audit` findings: 1 critical, 3 high, 2 moderate (all install-time/CLI or unused, see `attack-surface.md` §13).
- [ ] Upgrade `multer` to 2.x.
- [ ] Remove unused `aws-sdk` v2.
- [ ] Remove or align stale `package.production.json`.
- [ ] Automated dependency scanning in CI (no `.github/`).
- [x] Lockfile committed; Docker builder uses `npm ci`.

### 15. Logging / monitoring
- [x] Structured JSON logs (winston) to stdout and rotating files.
- [x] Secrets/keys/passwords not logged (log scan found none).
- [x] Admin actions and sign-in events in `audit_logs`, scoped by viewer.
- [~] Audit write failures are swallowed (`auditService.ts:91-93`).
- [~] Failed-login audit stores attempted email for unknown accounts (may capture typed passwords).
- [ ] Alerting on security events (cross-tenant attempts, lockouts, enrolments, webhook signature failures).
- [ ] Error tracking / APM (`SENTRY_DSN`, `NEW_RELIC_*` unused).
- [ ] Audit trail for customer-side actions beyond app logs.

### 16. Admin security
- [x] Admin API separated under `/admin`, all routes authenticated, password-change gate.
- [x] Dashboard relays admin calls server-side; real client IP restored only with a shared secret (`trustedProxy.ts`).
- [~] Temporary passwords and printer keys are returned in API responses (by design; must not be logged by `mprnt-admin`).
- [ ] MFA, IP allow-listing or step-up auth for super-admin operations (pricing, enrolment, org suspension, key rotation).
- [~] Owner-level staff management lacks hierarchy checks (T-05).

### 17. Deployment / infrastructure
- [x] Multi-stage Docker build, non-root user, `dumb-init`, health check.
- [x] Graceful shutdown drains requests and document jobs.
- [x] Production refuses to start without critical secrets.
- [?] `NODE_ENV=production` set in every internet-reachable deployment (T-01).
- [?] `ALLOW_TEST_PAYMENTS` unset in production (F-6 / T-11).
- [?] Exactly one proxy hop in front of the app (`trust proxy 1`) (T-12).
- [?] Build path used by Railway (Dockerfile vs `npm run build` with `npm install`).
- [~] Single instance assumed (in-memory limiter, cache, WebSocket state).
- [~] Local compose exposes DB/MinIO/Adminer on all interfaces with default credentials and a public dev bucket — dev only.
- [ ] CI pipeline (tests, lint, audit) before deploy.

### 18. Data privacy
- [x] Customer documents deleted from S3 on session expiry (`jobs/sessionExpiryJob.ts:58-98`).
- [~] Image thumbnails not deleted on expiry (T-08).
- [x] Admin session reports exclude filenames and customer IPs ("privacy boundary", `dashboardService.ts:587`).
- [ ] Retention policy for `print_sessions.client_ip`/`user_agent`, `leads`, `audit_logs`, `printers.last_seen_ip`.
- [~] Customer pre-signed URLs valid for 1 hour.
- [ ] Documented data-subject deletion process for leads/customers.

### 19. Error handling
- [x] Central handler: `AppError` → status + message; parser errors → 400/413; others → generic 500.
- [x] `/health/ready` hides DB error detail.
- [x] `unhandledRejection` logged; `uncaughtException` exits for a clean restart.
- [~] 404 handler echoes `req.originalUrl` (JSON, low risk).
- [~] Some `AppError` messages include internal state (order ids, Razorpay payment status) — visible only to the session holder.

### 20. Backup / recovery
- [?] Postgres backups / PITR — not configured in the repository; Railway-managed state must be verified.
- [?] S3 versioning / replication / lifecycle — not configured in the repository.
- [x] Financial history preserved through soft-deletes and `RESTRICT` constraints; refresh-token pruning only removes >30-day-old revoked/expired rows.
- [ ] Documented restore procedure and restore test.
- [ ] Incident-response runbook for secret leakage (JWT, provisioning token, Razorpay, AWS).

---

## Part B — Findings by class

Format for each: **Severity → Evidence → Risk → Affected location → Why it matters → Recommended fix**. Nothing below has been changed in the code.

### B1. Confirmed vulnerabilities

#### CV-1 Unauthenticated WebSocket with unbounded resources (T-03)
- **Severity:** Medium
- **Evidence:** `new WebSocketServer({ server, path })` with no options (`src/services/websocketService.ts:16`) → `ws` default `maxPayload` 100 MiB; no auth/origin check; `subscribe` adds to `subscriptions` for every message while `clients` keeps only the last job id (`:53-59`); disconnect removes only that one (`:85-90`).
- **Risk:** Memory exhaustion of the single API process by an anonymous client; anyone with a job id can watch its status.
- **Affected location:** `src/services/websocketService.ts`, `src/index.ts:20`.
- **Why it matters:** One process serves payments, kiosks and printers; a crash interrupts every shop.
- **Recommended fix:** Require the session token (or a signed job-scoped ticket) on subscribe; set `maxPayload` (e.g. 4 KB); limit connections per IP and subscriptions per socket; track a `Set` of job ids per client; validate `Origin`.

#### CV-2 Razorpay API reachable with attacker-controlled path from an unauthenticated request (T-04)
- **Severity:** Medium
- **Evidence:** `verifyPaymentSchema` accepts any strings (`src/validators/paymentValidator.ts:10-21`); `sessionTokenForOrder` passes through for unknown `orderId` (`src/middleware/sessionAuth.ts:32-35`, `:60-65`); `verifyAndCapturePayment` calls the gateway before checking the DB (`src/services/paymentService.ts:203`); gateway does `GET /payments/${paymentId}` unencoded with platform Basic auth (`src/services/razorpayService.ts:208`).
- **Risk:** Unlimited authenticated Razorpay API calls (quota exhaustion → real customers' verifications fail); path/query manipulation within Razorpay's v1 GET API; minor oracle via differing error messages.
- **Affected location:** `src/routes/payment.ts:182`, files above.
- **Why it matters:** Payment verification is on the critical revenue path; credentials are used on attacker input.
- **Recommended fix:** Validate `^order_[A-Za-z0-9]+$` / `^pay_[A-Za-z0-9]+$` / hex signature; `encodeURIComponent` path segments; look up the order and enforce the session token *before* any gateway call; make the session middleware reject (404) unknown resources on mutating routes.

### B2. Security weaknesses

#### SW-1 Hard-coded JWT fallback and `NODE_ENV`-string gating (T-01, F-1)
- **Severity:** High (conditional)
- **Evidence:** `src/config/environment.ts:92`, `:106`, `:211`; `src/routes/setup.ts:18-25`; `src/routes/payment.ts:26-33`; `src/config/database.ts:35`.
- **Risk:** Any deployment not started with exactly `NODE_ENV=production` accepts super-admin tokens signed with a public string and exposes dev endpoints.
- **Affected location:** as listed.
- **Why it matters:** Total platform compromise from one configuration slip.
- **Recommended fix:** Remove the fallback; validate secrets in all environments; gate dev routes behind an explicit opt-in flag (e.g. `ENABLE_DEV_ENDPOINTS=true`) that production refuses.

#### SW-2 Provisioning token enrols on any kiosk (T-02, F-8)
- **Severity:** Medium
- **Evidence:** `src/validators/queueValidator.ts:22-35`; `src/services/fleetService.ts:133-190`; `src/routes/queue.ts:67`.
- **Risk:** Token holder obtains a printer key at any shop and receives paid customer documents.
- **Affected location:** printer enrolment flow.
- **Why it matters:** Customer documents are the most sensitive asset.
- **Recommended fix:** Per-kiosk single-use enrolment codes issued from the dashboard, or require super-admin approval before a device-enrolled printer may poll; alert on enrolment.

#### SW-3 No role hierarchy in staff management (T-05)
- **Severity:** Medium
- **Evidence:** `src/services/adminUserService.ts:173-218` (update), `:250-273` (reset returns password), `:311-368` (overrides, including self).
- **Risk:** Account takeover of co-owners; self-promotion by any `staff:write` holder.
- **Affected location:** `/api/v1/admin/users/*`.
- **Why it matters:** Owners control refunds and staff; disputes between co-owners/managers are realistic.
- **Recommended fix:** Disallow actions on equal/higher roles and on self (role/permissions); require current-password re-auth for resets; consider emailing reset passwords instead of returning them.

#### SW-4 Database TLS without certificate verification (T-07, F-7)
- **Severity:** Medium
- **Evidence:** `src/config/database.ts:35`.
- **Risk:** MITM of DB credentials and data.
- **Affected location:** DB pool configuration.
- **Why it matters:** Protects every stored asset.
- **Recommended fix:** `rejectUnauthorized: true` with the provider CA, or document a private network.

#### SW-5 Thumbnails survive session expiry (T-08)
- **Severity:** Medium
- **Evidence:** thumbnails written at `src/workers/documentProcessor.ts:67-68`; expiry deletes only `doc.s3_key` (`src/jobs/sessionExpiryJob.ts:76-80`); explicit delete does remove them (`src/services/documentService.ts:205-214`).
- **Risk:** Indefinite retention of derivatives of customers' images (e.g. ID cards).
- **Affected location:** `src/jobs/sessionExpiryJob.ts`.
- **Why it matters:** Contradicts the evident data-minimisation intent; privacy exposure if the bucket is ever exposed.
- **Recommended fix:** Delete `-thumb.jpg` (and any `-thumb-page<N>.jpg`) alongside the original; add an S3 lifecycle rule on `sessions/` as a backstop.

#### SW-6 Vulnerable / deprecated dependencies (T-15)
- **Severity:** Medium
- **Evidence:** `npm audit --omit=dev`: 1 critical, 3 high, 2 moderate; `multer@1.4.5-lts.2` deprecated for vulnerabilities; unused `aws-sdk` v2.
- **Risk:** Known-vulnerable code in install path and request path (multer).
- **Affected location:** `package.json`, `package-lock.json`.
- **Why it matters:** Upload parsing is unauthenticated-adjacent and internet-facing.
- **Recommended fix:** Upgrade `multer` to 2.x, `bcrypt` (or switch to `bcryptjs`/`@node-rs/bcrypt`), `node-pg-migrate`; remove `aws-sdk`; add scheduled `npm audit` in CI.

#### SW-7 Admin lockout abuse and account enumeration (T-10)
- **Severity:** Medium
- **Evidence:** `src/services/adminAuthService.ts:45-46`, `:106-112`, `:184-202`; limiter key `src/routes/admin.ts:49-58`.
- **Risk:** Targeted denial of dashboard access; confirmation that an email is an admin.
- **Affected location:** `/api/v1/admin/auth/login`.
- **Why it matters:** Shop owners rely on the dashboard for refunds and printer revocation during incidents.
- **Recommended fix:** Progressive delays/CAPTCHA instead of hard lock, same response for locked and invalid, per-account cross-IP throttling, MFA.

#### SW-8 Upload content trust (T-09)
- **Severity:** Low–Medium
- **Evidence:** `src/middleware/upload.ts:10-23`; `src/services/storageService.ts:47`; `src/services/documentService.ts:32-50`, `:93`.
- **Risk:** Malformed/malicious files reach PDF/image parsers in-process and the Pi print pipeline; odd characters in S3 keys.
- **Affected location:** upload flow.
- **Why it matters:** Untrusted binary parsing on the only API process.
- **Recommended fix:** Magic-byte check (e.g. `file-type`), derive extension from the verified type, parse in a worker thread with a timeout, optional AV scan.

#### SW-9 Stale admin access tokens (T-06)
- **Severity:** Low
- **Evidence:** `src/services/adminAuthService.ts:357-389`.
- **Risk:** Up to 15 min of access after deactivation/suspension/role change.
- **Affected location:** `authenticateAdmin`.
- **Why it matters:** Offboarding and incident response.
- **Recommended fix:** Embed a token version / `password_changed_at` and check it (cacheable) in `authenticateAdmin`.

#### SW-10 Resource exhaustion on public paths (T-14)
- **Severity:** Low–Medium
- **Evidence:** `src/app.ts:45-56`; `src/middleware/upload.ts:26`; `src/middleware/sessionAuth.ts:32-35`.
- **Risk:** Memory/CPU pressure from large bodies and buffered uploads.
- **Affected location:** global middleware, upload route.
- **Why it matters:** Single-instance availability.
- **Recommended fix:** Small default JSON limit (e.g. 100 KB) with route-specific overrides; reject unknown sessions before multer.

#### SW-11 CSV formula injection in export (T-13)
- **Severity:** Low
- **Evidence:** `src/services/dashboardService.ts:607-610`; printer `name` from device (`src/validators/queueValidator.ts:42`).
- **Risk:** Formula execution in a shop owner's spreadsheet.
- **Affected location:** `GET /api/v1/admin/reports/sessions/export`.
- **Why it matters:** Exports are opened in Excel/Sheets by non-technical users.
- **Recommended fix:** Prefix cells starting with `=`, `+`, `-`, `@`, tab or CR with `'`.

#### SW-12 Refresh-token rotation race
- **Severity:** Low
- **Evidence:** `src/services/adminAuthService.ts:275-330` reads then updates without lock or `revoked_at IS NULL` condition.
- **Risk:** A stolen refresh token used concurrently with the legitimate one may yield two valid token chains without triggering reuse detection.
- **Affected location:** `refresh()`.
- **Why it matters:** Weakens the reuse-detection guarantee.
- **Recommended fix:** `UPDATE … SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id` before issuing new tokens; treat 0 rows as replay.

#### SW-13 Information disclosure in public metadata
- **Severity:** Low
- **Evidence:** `/health` returns `environment` (`src/app.ts:104-111`); Swagger public (`src/config/swagger.ts:303-319`) with inaccurate "no authentication" text (`src/config/swagger.ts:21-26`).
- **Risk:** Reconnaissance; integrators misled about auth.
- **Affected location:** `src/app.ts`, `src/config/swagger.ts`.
- **Why it matters:** Low-cost hardening.
- **Recommended fix:** Drop `environment` from `/health`; serve docs only outside production or behind admin auth; correct the description.

### B3. Missing controls

| ID | Control | Severity | Evidence of absence | Recommended fix |
|---|---|---|---|---|
| MC-1 | MFA for admins (esp. super admin) | Medium | No MFA code/tables in `src/` or `migrations/` | TOTP/WebAuthn for super admins first |
| MC-2 | Security alerting / error tracking | Low–Medium | `SENTRY_DSN`, `NEW_RELIC_*` unused; only `logger.warn` | Ship logs to a SIEM; alert on cross-tenant attempts, lockouts, enrolments, webhook signature failures |
| MC-3 | Malware scanning of uploads | Low–Medium | `ENABLE_FILE_VIRUS_SCAN` unused | ClamAV/S3 scanning before a job can be paid/printed |
| MC-4 | Retention for customer IP/UA, leads, audit logs | Low–Medium | No delete jobs for those tables | Define retention; scheduled purge |
| MC-5 | Least-privilege DB roles; RLS | Low–Medium | Single `DATABASE_URL` for app and migrations | Separate migrator/runtime roles; consider RLS on tenant tables |
| MC-6 | CI with tests, lint, audit | Low | No `.github/` | Add pipeline gating deploys |
| MC-7 | Backup/restore runbook and test | Medium | Nothing in repo | Document Railway PITR + S3 versioning; test restores |
| MC-8 | Secret rotation runbook / secret manager | Low | None in repo | See `secrets.md` §7 |
| MC-9 | Start-up check for webhook/S3/DB secrets | Low | `environment.ts:196-208` | Extend `missingProductionSettings` |
| MC-10 | WebSocket authentication and limits | Medium | `websocketService.ts` | See CV-1 |

### B4. Potential risks requiring verification

| ID | Item | What to verify | Why |
|---|---|---|---|
| PV-1 | `NODE_ENV` | Exactly `production` on every reachable deployment (prod, staging, previews) | SW-1 |
| PV-2 | `ALLOW_TEST_PAYMENTS` | Unset/false in production; Razorpay key is `rzp_live_` | T-11 / F-6 |
| PV-3 | Proxy hops | Railway places exactly one proxy in front; `X-Forwarded-For` cannot be appended by clients beyond it | T-12 |
| PV-4 | S3 bucket | Block Public Access on, default encryption on, no anonymous policy, lifecycle/versioning configured | T-08 |
| PV-5 | `CORS_ORIGIN` | Set to the real customer frontend origin(s) only | §13 |
| PV-6 | Frontend & `mprnt-admin` rendering | Output-encode filenames, names, lead fields; never log temp passwords/printer keys | T-13 |
| PV-7 | `.env.production.secrets.local` | Values saved in Railway; file deleted; rotate if ever synced | F-3 |
| PV-8 | Local `.env` Razorpay keys | Test-mode and distinct from production | F-5 |
| PV-9 | Postgres backups | PITR enabled and tested | MC-7 |
| PV-10 | Build path | Whether Railway builds with the Dockerfile (`npm ci`) or `npm run build` (`npm install`) | Supply-chain reproducibility |
| PV-11 | DB network | Whether DB traffic stays on Railway private networking | SW-4 |

### B5. Recommendations (no defect behind them)

- Remove dead security code: `src/middleware/auth.ts`, unused `validateSessionId`/`validateFileUpload` in `src/middleware/validation.ts`, unused `sessionOperationRateLimiter`, unused `storageService.getPublicUrl()`.
- Pin `algorithms: ['HS256']` in `jwt.verify` and enforce a minimum `JWT_SECRET` length.
- Shorten customer pre-signed URL TTL (1 h → a few minutes) and avoid caching URLs in the preview cache longer than their usefulness.
- Rename `.env.production` → `.env.production.example` and align with `environment.ts` (F-4); set `CORS_CREDENTIALS=false` since no cookies are used.
- Replace `LIMIT ${limit} OFFSET ${offset}` in `auditService.list` with bound parameters for defence in depth.
- Use a shared store (Postgres/Redis) for rate limits if more than one instance is ever run.
- Bind local compose ports to `127.0.0.1` and remove `mc anonymous set download` from `docker-compose.yml`.
- Strip the `attemptedEmail` value (or hash it) in failed-login audit rows.
- Make audit-log write failures visible (metric/alert) rather than only logged.
