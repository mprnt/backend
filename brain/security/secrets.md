# Secrets — mprnt-backend

> Assessed 2026-10-05 at commit `dd1221b`. No secret values are reproduced in this
> document. Files containing values were inspected only to classify them
> (empty / placeholder / non-placeholder) and to check for leaks.

## 1. Where secrets are expected

All runtime configuration is read once from `process.env` in `src/config/environment.ts` (after `dotenv.config()` loads `.env` if present). No other file reads secrets at runtime, except the scripts noted below.

| Secret | Env var(s) | Consumer | What it protects | Required in production? |
|---|---|---|---|---|
| Admin JWT signing key | `JWT_SECRET` | `src/services/adminAuthService.ts:236`, `:368`; legacy unused `src/middleware/auth.ts:30` | Every admin access token (all tenants, super admin) | Yes — start-up refuses the default `change_this_secret` (`environment.ts:199`) **only when `NODE_ENV === 'production'`** |
| Printer provisioning token | `PRINTER_PROVISIONING_TOKEN` | `src/middleware/printerAuth.ts:77-95` | Device self-enrolment → printer API key for any kiosk | Yes (`environment.ts:198`) |
| Razorpay key id / secret | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `src/services/razorpayService.ts:66-73`, Basic auth `:76`, HMAC `:197`, `:215` | Charging, refunding, verifying payments | Yes (`environment.ts:200-207`) |
| Razorpay webhook secret | `RAZORPAY_WEBHOOK_SECRET` | `src/services/paymentService.ts:244-250` | Authenticity of `payment.captured` / `order.paid` webhooks | **No** — webhook answers 503 when unset |
| AWS / MinIO credentials | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (+ `AWS_REGION`, `S3_BUCKET_NAME`, `S3_ENDPOINT`) | `src/services/storageService.ts:22-30` | Read/write/delete of all customer documents | **No** start-up check (empty strings are passed to the SDK) |
| Database credentials | `DATABASE_URL` or `DB_HOST`/`DB_USER`/`DB_PASSWORD`/… | `src/config/database.ts:24-36`; `.pgmigrate.json`; `scripts/setup-kiosks.js:9`, `scripts/setup-db.sh` | Entire database | No start-up check |
| Admin proxy secret | `ADMIN_PROXY_SECRET` | `src/middleware/trustedProxy.ts:26-55` | Lets `mprnt-admin` assert the real admin IP | Optional (feature disabled when empty) |
| Customer session tokens | generated (not env) | `src/services/sessionAccessService.ts:27-30` | One session's document/job/payment | n/a — 256-bit, only SHA-256 stored |
| Printer API keys | generated (not env) | `src/services/printerAuthService.ts:36-47` | One printer | n/a — 256-bit, only SHA-256 stored, shown once |
| Admin refresh tokens | generated | `src/services/adminAuthService.ts:240-252` | Admin session renewal | n/a — 384-bit, only SHA-256 stored |
| Admin temporary passwords | generated | `src/services/adminUserService.ts:48-54`, `scripts/create-super-admin.ts:19-26` | Initial/reset admin login | n/a — bcrypt stored, shown once, forced change |

Variables present in `.env.example` but **not read by any code** (so they provide no protection even if set): `JWT_ACCESS_TOKEN_EXPIRY`/`JWT_REFRESH_TOKEN_EXPIRY` (loaded into config but never used; admin tokens use `ADMIN_ACCESS_TOKEN_TTL*`), `ADMIN_EMAIL`, `ADMIN_DEFAULT_PASSWORD`, `SENTRY_DSN`, `NEW_RELIC_LICENSE_KEY`, `ENABLE_FILE_VIRUS_SCAN`, `SESSION_RATE_LIMIT_*`, `HEALTH_CHECK_*`. The tracked `.env.production` also lists `REDIS_URL`, `AWS_S3_BUCKET`, `WEBSOCKET_PORT`, `WEBSOCKET_PATH`, `SESSION_EXPIRY_HOURS`, `PAYMENT_TIMEOUT_SECONDS`, `PRINTER_*_MINUTES`, none of which the code reads.

## 2. Environment / configuration handling

| Mechanism | Evidence | Assessment |
|---|---|---|
| Single typed config module | `src/config/environment.ts` | Good: one place to audit. |
| Production fail-closed check | `environment.ts:196-227`, tests in `tests/config/environment.test.ts` | Good, but gated on the exact string `NODE_ENV === 'production'`. With any other value the hard-coded JWT fallback is accepted silently. |
| Hard-coded fallback secret | `environment.ts:106` `JWT_SECRET \|\| 'change_this_secret'` | Weakness (see F-1). |
| Empty-string fallbacks | `environment.ts` for DB password, AWS keys, Razorpay, webhook, proxy secret | Fail-open for S3/DB (errors at first use rather than at boot). |
| Razorpay "mock mode" selection | `razorpayService.ts:125-127` — any key not starting with `rzp_` → in-memory mock payments | Blocked in production by the start-up check; in any non-production deployment a placeholder key makes all payments simulated. |
| Test keys in production | `ALLOW_TEST_PAYMENTS` (`environment.ts:142`, `:200-202`, `:216-226`) | Intentional temporary switch; see F-6. |
| `.env` loading | `dotenv.config()` loads only `.env` | `.env.production` is never loaded by the app; it is documentation only. |
| Docker image | `.dockerignore` excludes `.env` and `.env.*` (keeps `.env.example`); `Dockerfile` copies only `package*.json`, `tsconfig.json`, `src`, `dist` | Good: no env files baked into images. |
| Railway uploads | `.railwayignore` excludes `.env`, `.env.local`, `.env.*.local`, `*.example` | `.env.production` is **not** excluded (it is tracked anyway and holds placeholders only). |
| Git | `.gitignore` excludes `.env`, `.env.local`, `.env.*.local`, `logs/`, `coverage/`, `dist/` | Verified with `git check-ignore`: `.env`, `.env.production.secrets.local`, `logs/*.log` are ignored. |

## 3. Hard-coded secret risks

| Location | What | Real secret? | Risk |
|---|---|---|---|
| `src/config/environment.ts:106` | JWT fallback string | Known public string | **High if `NODE_ENV` ≠ `production` in a reachable deployment** (F-1) |
| `docker-compose.yml:10`, `:31-32`, `:55`; `docker-compose.minimal.yml:10` | Postgres and MinIO root credentials for local containers | Development-only defaults | Low; becomes real if these compose files are used on a shared host — ports are published on all interfaces (`5432`, `9000`, `9001`, `8080` Adminer) |
| `src/services/adminAuthService.ts:99` | Dummy bcrypt string for timing equalisation | Not a credential | None |
| `src/config/swagger.ts:152` | Example `rzp_test_1234567890` | Example only | None |
| `tests/**` | Test fixtures | Not reviewed as secrets; no real-key patterns found | None |

Pattern scan of **all** git history (`git log --all -p`) for `rzp_live_…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `mprnt_pk_<key>`, `sk_live_`: **0 matches**. The only `rzp_` occurrence in history is the swagger example above.

## 4. Client-side exposure risks

| Item | Evidence | Assessment |
|---|---|---|
| Razorpay **key id** returned to customers | `src/controllers/paymentController.ts:46` | Expected — the key id is public by design for Razorpay Checkout. The secret is never returned. |
| Session token returned once | `src/controllers/sessionController.ts:84-85` | Expected. Client must keep it out of URLs/logs (frontend not in scope). |
| Printer API key returned once | `src/controllers/queueController.ts:47-50`, `src/controllers/adminController.ts:420-429`, `:446-455` | Expected; transmitted to the Pi / super admin. |
| Admin temporary passwords returned in API responses | `src/controllers/adminController.ts:223-227`, `:279-283` | By design; they traverse `mprnt-admin` and the admin's browser. |
| Mock payment signature returned | `src/controllers/paymentController.ts:184-201` | Dev-only route (404 in production). In any non-production deployment it signs with the configured `RAZORPAY_KEY_SECRET`. |
| Pre-signed S3 URLs | `src/services/documentService.ts:238-246`, `:309`; `src/services/queueService.ts:394-397` | Bearer URLs (1 h customer, 15 min printer). Anyone holding one can download that document until expiry. |
| Swagger spec | `/api-docs`, `/api-docs.json` (`src/config/swagger.ts`) | No secrets; publicly reveals route structure in every environment. |

No secret is embedded in any response body, header, or HTML produced by this service.

## 5. Git / history exposure risks

| File | Tracked | Contents (classified) | Finding |
|---|---|---|---|
| `.env.example` | yes | All secret-like values are placeholders; `PRINTER_PROVISIONING_TOKEN` and `ADMIN_PROXY_SECRET` empty | OK |
| `.env.production` | **yes** | `NODE_ENV`, DB URL with placeholder password and host, placeholder Razorpay/AWS values, empty `PRINTER_PROVISIONING_TOKEN`; no `JWT_SECRET`, `RAZORPAY_WEBHOOK_SECRET` or `ADMIN_PROXY_SECRET` lines | F-4 (naming/process risk, no leak) |
| `pi_client/.env.example` | in history | Added in history; not present in working tree | Placeholder-only per scan |
| `.env` | no (ignored) | Local development values, including non-placeholder Razorpay key id/secret and a provisioning token | Local only; F-5 |
| `.env.production.secrets.local` | no (ignored) | `JWT_SECRET` and `PRINTER_PROVISIONING_TOKEN` (64-char values) with a header saying to delete the file after saving to Railway | F-3 |
| `logs/app.log`, `logs/error.log` | no (ignored) | ~12k lines; scanned for printer keys, JWTs, `Bearer`, `sessionToken`, `refreshToken`, `temporaryPassword`, `"password"`, `X-Session-Token`, `apiKey`: **0 matches** | OK |
| `qr-M001.png/.svg` | no (ignored) | Kiosk QR codes | Not secret |

Every secret-like line ever added to an env file in git history was classified as empty or placeholder by the scan (`ADMIN_DEFAULT_PASSWORD`, `AWS_*`, `DATABASE_URL`, `DB_PASSWORD`, `JWT_SECRET`, `RAZORPAY_*`, `REDIS_PASSWORD`, `NEW_RELIC_LICENSE_KEY`, `PRINTER_PROVISIONING_TOKEN`, `ADMIN_PROXY_SECRET`).

## 6. Logging / error exposure risks

Verified good practice:

- Printer keys are never logged; only the 16-char prefix (`printerAuthService.ts:109-112`, `:144`; audit details in `adminController.ts:417`, `:443`).
- Admin passwords and temporary passwords are never logged (`adminController.ts:219`, `adminAuthService.ts:165`).
- Session tokens are not logged (`sessionService.ts:146-150` logs only `sessionId`).
- DB errors log the SQL text but **not** parameters (`src/config/database.ts:82-86`).
- Unexpected errors return a generic `Internal server error`; stack traces only go to logs (`src/middleware/errorHandler.ts:66-76`).
- `/health/ready` deliberately hides DB error detail (`src/app.ts:149-157`).

Residual exposure:

| Item | Evidence | Risk |
|---|---|---|
| Attempted email for unknown accounts stored in audit details | `adminAuthService.ts:177` | Users sometimes type a password into the email field; that value would be persisted in `audit_logs` and shown to super admins. Low. |
| `createPaymentOrder` failure logs full `params` and the raw error object | `paymentService.ts:184` | Params are job id/amount/currency only; the error object could contain Razorpay error payloads. Low. |
| `logger.error('Error capturing payment', { error, … })` / `logger.error('Failed to write audit log', { error, … })` | `paymentService.ts:314`, `auditService.ts:92` | Whole error objects (pg errors can include parameter values in `detail`). Low. |
| Morgan `combined` access logs in production | `src/app.ts:65-71` | Logs full URLs; no secret is passed in a URL by this API, so currently safe. Pre-signed URLs are generated server-side and not logged as request URLs. |
| `AppError` messages echoed to clients | e.g. `paymentService.ts:150`, `razorpayService.ts:225` | Reveal order ids / Razorpay payment status to the session holder only. Low. |
| Uncaught Razorpay API errors | `razorpayService.ts:98-107` | Converted to plain `Error` → generic 500 to the client; full description in logs only. OK. |

## 7. Secret rotation requirements

| Secret | How to rotate | Blast radius / notes |
|---|---|---|
| `JWT_SECRET` | Change env var and restart | Instantly invalidates every admin access token (no key id / dual-key support in `verifyAccessToken`); refresh tokens are DB-backed and keep working, so admins silently re-authenticate via refresh. Rotate immediately on any suspicion; also if a non-production deployment ever ran with the default. |
| `PRINTER_PROVISIONING_TOKEN` | Change env var and restart | Does not affect already-enrolled printers (they use their own keys). Rotate after every installation campaign or installer turnover, since it enrols on any kiosk. |
| Printer API keys | `POST /api/v1/admin/printers/:printerId/rotate-key` (super admin) or `/revoke` (owner) | Old key stops working immediately (`printerAuthService.ts:125-152`). Rotate on Pi loss/theft/re-imaging. |
| `RAZORPAY_KEY_SECRET` / key id | Regenerate in Razorpay dashboard, update env, restart | Signature verification and API calls depend on it; orders created with the old key pair remain verifiable only with the old secret — coordinate with in-flight payments. |
| `RAZORPAY_WEBHOOK_SECRET` | Update in Razorpay webhook settings and env together | Single secret; webhooks fail (400) during the gap; the verify path continues to work. |
| AWS keys | Create new IAM key, deploy, then deactivate old | Prefer a least-privilege IAM user scoped to the one bucket (`s3:PutObject/GetObject/DeleteObject`). Not codified in the repo. |
| Database password | Rotate in provider, update `DATABASE_URL` | Same credential is used for migrations (`.pgmigrate.json`) and runtime. |
| `ADMIN_PROXY_SECRET` | Change in both `mprnt-backend` and `mprnt-admin` (`MPRNT_PROXY_SECRET`) simultaneously | No dual-secret support: during a mismatch the API logs warnings and falls back to the dashboard's IP (fails safe). |
| Admin passwords | `/admin/auth/change-password`, `/admin/users/:id/reset-password`, or `scripts/create-super-admin.ts` (super admin) | Refresh tokens are revoked on change/reset; outstanding access tokens remain valid ≤15 min. |

There is no secret-manager integration, no scheduled rotation, and no rotation runbook in the repository (Missing control).

## 8. Findings

Format: **Severity → Evidence → Risk → Affected location → Why it matters → Recommended fix**

### F-1 Hard-coded JWT secret fallback with environment-name-gated guard
- **Class:** Security weakness (+ Potential risk requiring verification: actual `NODE_ENV` in every deployed environment)
- **Severity:** High (conditional on `NODE_ENV` not being exactly `production`)
- **Evidence:** `secret: process.env.JWT_SECRET || 'change_this_secret'` (`src/config/environment.ts:106`); the only check is inside `if (env.node_env === 'production')` (`:211`); `node_env` defaults to `'development'` (`:92`).
- **Risk:** Anyone can mint a `super_admin` access token for any deployment started without `JWT_SECRET` and without `NODE_ENV=production` (staging, preview, misconfigured prod).
- **Affected location:** `src/config/environment.ts`, `src/services/adminAuthService.ts:364-389`.
- **Why it matters:** The JWT is the only control in front of every admin and platform operation.
- **Recommended fix:** Remove the fallback and refuse to start whenever `JWT_SECRET` is missing or shorter than ~32 bytes, in every environment; enforce a minimum length. Also consider pinning `algorithms: ['HS256']` in `jwt.verify`.

### F-2 Webhook secret and storage/database credentials are not required at start-up
- **Class:** Missing control
- **Severity:** Low
- **Evidence:** `missingProductionSettings` (`environment.ts:196-208`) checks only provisioning token, JWT secret and Razorpay id/secret. `RAZORPAY_WEBHOOK_SECRET`, `AWS_*`, DB credentials default to `''`.
- **Risk:** A deployment can run with webhooks disabled (503) — payments then depend solely on the client calling `/payment/verify` — or with broken storage that fails only on first upload.
- **Affected location:** `src/config/environment.ts`.
- **Why it matters:** Silent degradation of payment reconciliation and availability; operators may not notice.
- **Recommended fix:** Add these to the production checklist in code (or at least log a start-up warning).

### F-3 Plaintext production secrets file on the developer machine
- **Class:** Potential risk requiring verification
- **Severity:** Low
- **Evidence:** Untracked, git-ignored `.env.production.secrets.local` (mode `0600`) holding `JWT_SECRET` and `PRINTER_PROVISIONING_TOKEN`; its own header says to delete it once saved in Railway (dated 2026-09-29).
- **Risk:** Disclosure through backups, sync tools, or another process/user on the workstation; the provisioning token enables rogue printer enrolment (threat-model T-02) and the JWT secret enables super-admin forgery.
- **Affected location:** repository root (local only).
- **Why it matters:** These are the two highest-value secrets in the system.
- **Recommended fix:** Confirm both values are in Railway, then delete the file (and rotate if it was ever synced/shared). Store such values in a password manager instead.

### F-4 Tracked `.env.production` template
- **Class:** Recommendation
- **Severity:** Low
- **Evidence:** `.env.production` is committed (`git ls-files`), contains placeholders only, references variables the code does not read (`REDIS_URL`, `AWS_S3_BUCKET`, `WEBSOCKET_*`, …) and omits ones it does need (`JWT_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_PROXY_SECRET`, `S3_BUCKET_NAME`). Not excluded by `.railwayignore`.
- **Risk:** A file with a "real" env name invites someone to fill in real values and commit them; the stale variable list can cause misconfiguration (e.g. bucket name falling back to the default `mprnt-documents`).
- **Affected location:** `.env.production`, `.railwayignore`.
- **Why it matters:** Prevents a future secret leak and configuration drift.
- **Recommended fix:** Rename to `.env.production.example`, align it with `src/config/environment.ts`, and add `.env.production` to `.gitignore`/`.railwayignore`.

### F-5 Local `.env` contains non-placeholder third-party keys
- **Class:** Potential risk requiring verification
- **Severity:** Low
- **Evidence:** Git-ignored `.env` has non-placeholder `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` values and a 64-char `PRINTER_PROVISIONING_TOKEN`.
- **Risk:** If these are Razorpay **test** credentials (likely, given development use), exposure is limited; if shared with any deployed environment, local compromise exposes it.
- **Affected location:** `.env` (local only).
- **Why it matters:** Ensures development and production secrets are disjoint.
- **Recommended fix:** Verify they are test-mode keys and distinct from all deployed values.

### F-6 Production may run on Razorpay test keys
- **Class:** Potential risk requiring verification
- **Severity:** Medium (if enabled)
- **Evidence:** `ALLOW_TEST_PAYMENTS` (`environment.ts:142`, `:200-202`, `:216-226`); commit `fb1cc4e`.
- **Risk:** Test-mode checkout queues real prints without real money.
- **Affected location:** Railway environment variables.
- **Why it matters:** Direct revenue loss and abuse.
- **Recommended fix:** Confirm the flag is unset in production; remove the code path at launch as the comment says.

### F-7 Database TLS does not verify the server certificate
- **Class:** Security weakness
- **Severity:** Medium
- **Evidence:** `ssl: env.node_env === 'production' ? { rejectUnauthorized: false } : undefined` (`src/config/database.ts:35`).
- **Risk:** The DB password in `DATABASE_URL` and all query traffic can be intercepted by a man-in-the-middle.
- **Affected location:** `src/config/database.ts`.
- **Why it matters:** Protects A15 (DB credentials) and all stored data in transit.
- **Recommended fix:** Supply the provider's CA (`ssl: { ca, rejectUnauthorized: true }`) or document that traffic stays on a private, authenticated network.

### F-8 Shared, broad-scope secrets
- **Class:** Security weakness
- **Severity:** Medium
- **Evidence:** One `PRINTER_PROVISIONING_TOKEN` enrols a printer on any kiosk (`src/validators/queueValidator.ts:22-35`, `src/services/fleetService.ts:133-190`); one `JWT_SECRET` for all tenants; one DB credential for migrations and runtime (`.pgmigrate.json`); one static AWS key pair for the whole bucket.
- **Risk:** A single leaked value has platform-wide impact.
- **Affected location:** as above.
- **Why it matters:** Limits blast radius of an inevitable leak.
- **Recommended fix:** Per-kiosk, single-use enrolment codes; least-privilege IAM for S3; separate DB roles for migration vs runtime; consider an asymmetric (RS/ES) JWT key with `kid` to allow rotation.

### F-9 Unused legacy auth middleware sharing `JWT_SECRET`
- **Class:** Recommendation
- **Severity:** Low
- **Evidence:** `src/middleware/auth.ts` verifies any token signed with `JWT_SECRET` and trusts its `role` claim; it is not imported anywhere (`grep` finds no users).
- **Risk:** If re-used later, it would accept admin access tokens without checking `typ` and with a different role model.
- **Affected location:** `src/middleware/auth.ts`.
- **Why it matters:** Dead security code tends to be revived incorrectly.
- **Recommended fix:** Delete it.
