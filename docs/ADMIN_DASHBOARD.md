# MPrnt Admin API — two dashboards, one surface

Backend reference for the admin frontend (`mprnt-admin`).

Base URL: `/api/v1/admin`

Commission and settlements are **not** in this build — the prototype does not
split revenue. Everything else from the design is implemented.

---

## 1. The two layers

Both dashboards talk to the same endpoints. Which one a caller gets is decided
entirely by their token — there is no "dashboard type" parameter.

| | Super Admin | Shop Admin |
|---|---|---|
| Scope | All organizations | Exactly one |
| `organization_id` on their account | `NULL` | their shop |
| Creates organizations & staff | ✅ | ❌ |
| Sets pricing | ✅ | reads only |
| Sees revenue | every shop | their own |
| Created by | CLI only | a super admin |

`resolveTenant` derives the scope from the token on every request. A shop admin
who passes another organization's id gets **404**, and the attempt is logged.

---

## 2. Roles

| Permission | viewer | manager | owner | super |
|---|:--:|:--:|:--:|:--:|
| `reports:read`, `sessions:read`, `pricing:read`, `printers:read` | ✅ | ✅ | ✅ | ✅ |
| `printers:manage`, `jobs:cancel`, `staff:read`, `export:data` | | ✅ | ✅ | ✅ |
| `staff:write`, `refunds:issue`, `audit:read` | | | ✅ | ✅ |
| `orgs:read`, `orgs:write`, `pricing:write`, `platform:reports`, `audit:read_all` | | | | ✅ |

Roles are presets. `PUT /users/:id/permissions` grants or denies one permission
for one person on top of their role — **deny always wins**, and platform-scope
permissions can never be granted to shop staff.

---

## 3. Getting started

```bash
# 1. Migrate
npm run migrate:sql -- 011_admin_dashboard.sql

# 2. Create the first super admin (CLI only — there is no bootstrap endpoint)
npm run create-super-admin -- you@example.com "Your Name"
```

The password is printed once and must be changed on first sign-in.

### Why no super-admin endpoint?

That account can change every shop's pricing and read every shop's revenue.
Creating one requires shell access to the server, so a leaked API credential is
never enough. There is also no default account to forget about.

---

## 4. Authentication

```http
POST /admin/auth/login
{ "email": "owner@shop.com", "password": "..." }
```

```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "base64url...",
    "expiresIn": 900,
    "mustChangePassword": true,
    "user": { "id": "...", "role": "owner", "organizationId": "...", "permissions": [...] }
  }
}
```

Send `Authorization: Bearer <accessToken>` on every other call.

- **Access token: 15 minutes**, stateless, carries the permission set.
- **Refresh token: 7 days**, stored as a SHA-256 digest, revocable, and
  **rotated on every use**. Replaying a spent refresh token revokes every
  session for that account — a used token reappearing means it leaked.
- **5 failed sign-ins → 15-minute lock.** The correct password is still refused
  during a lock (423).
- Unknown email and wrong password return the identical 401, so the endpoint
  cannot be used to discover which addresses have accounts.

Deactivating, deleting, changing a role, changing a permission or suspending the
organization all revoke refresh tokens immediately. The current access token
remains valid for its remaining minutes — that window is the deliberate cost of
stateless verification. For anything that must cut access instantly, revocation
plus the short TTL is the mechanism.

### Frontend storage

Keep the refresh token in an **httpOnly cookie**, not `localStorage`. This
dashboard holds revenue and staff management; an XSS bug should not hand over a
7-day credential.

---

## 5. Endpoints

### Auth
| Method | Path | Who |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/refresh` | public |
| POST | `/auth/logout` | public |
| GET | `/auth/me` | any admin |
| POST | `/auth/change-password` | any admin |

### Organizations — super admin
| Method | Path |
|---|---|
| POST | `/organizations` |
| GET | `/organizations` `?status=&search=` |
| GET | `/organizations/:id` |
| PATCH | `/organizations/:id` |
| POST | `/organizations/:id/status` — `{"status":"suspended"}` |
| DELETE | `/organizations/:id` — soft delete |
| POST | `/organizations/:id/kiosks` — `{"kioskId":"uuid"}` |

Suspending signs out the shop's staff and blocks further sign-in. Deleting is
refused (409) while kiosks are still attached.

### Staff
| Method | Path | Permission |
|---|---|---|
| POST | `/users` | super admin only |
| GET | `/users` | `staff:read` |
| GET | `/users/:id` | `staff:read` |
| PATCH | `/users/:id` | `staff:write` |
| DELETE | `/users/:id` | `staff:write` |
| POST | `/users/:id/reset-password` | `staff:write` |
| POST | `/users/:id/unlock` | `staff:write` |
| GET | `/users/:id/permissions` | `staff:read` |
| PUT | `/users/:id/permissions` | `staff:write` |
| GET | `/permissions` | any admin — the catalogue, for rendering a grid |

`POST /users` returns a generated `temporaryPassword` **once**. It is never
stored in plaintext, never logged, and cannot be retrieved — only reset.

Deletes are soft: the row stays so `audit_logs` keeps resolving, and the email
is freed for reuse by a partial unique index.

### Reports
All accept `?period=day|week|month|year` **or** an explicit `?from=&to=`, plus
optional `?kioskId=`. A super admin may add `?organizationId=`.

| Method | Path | Permission |
|---|---|---|
| GET | `/reports/summary` | `reports:read` |
| GET | `/reports/series` `&bucket=` | `reports:read` |
| GET | `/reports/kiosks` | `reports:read` |
| GET | `/reports/sessions` `&status=&limit=&offset=` | `sessions:read` |
| GET | `/reports/sessions/export` → CSV | `export:data` |
| GET | `/printers` | `printers:read` |
| GET | `/kiosks` | `printers:read` |
| GET | `/attention` | `reports:read` |
| GET | `/audit` | `audit:read` |

### Pricing
| Method | Path | Permission |
|---|---|---|
| GET | `/pricing?kioskId=` | `pricing:read` |
| GET | `/pricing/lists` | `pricing:read` |
| POST | `/pricing/lists` | `pricing:write` (super admin) |

---

## 6. What a shop admin may see

Shop staff handle strangers' documents. The boundary is enforced in the query
layer — the columns are simply never selected — so a new endpoint cannot leak
them by forgetting a filter.

| Visible | Never returned |
|---|---|
| Job id, session code, timestamps | Document contents or thumbnails |
| Kiosk and printer | Original filename |
| Pages, copies, colour, duplex | S3 key or any download URL |
| Amount, price per page, payment status | Customer IP or user agent |
| Outcome, error message, duration | |

Super admins see no document content either. There is no business reason for it,
and not having the capability is a stronger guarantee than a policy.

---

## 7. Reporting periods and timezones

Every organization has a `timezone` (default `Asia/Kolkata`). Days are bucketed
in that zone, so "today" means the shop's today.

This matters more than it sounds. A job at 02:00 IST is the previous day in UTC;
bucketing naively puts a shop's late-evening takings on the wrong date and every
daily total is quietly wrong. Three separate bugs in this area were fixed during
development — all from the same root cause:

> `timestamp without time zone` read into JavaScript is interpreted in the Node
> process's local zone. On a non-UTC host, comparisons and `.toISOString()`
> silently shift by the offset.

**Rule for this codebase: compare and format timestamps in SQL, not in JS.**
Return dates as text with `to_char(...)`. Let Postgres do `NOW()` comparisons.

### Live vs. history

`/reports/*` reads live from `print_jobs`, so today is always current.
`daily_stats` is rolled up every 15 minutes for cheap long-range queries — a
yearly view over raw jobs would scan every job ever taken. The rollup recomputes
a rolling 3-day window and upserts, so a missed run heals itself.

---

## 8. Pricing

Set by the platform. Resolution is **most specific wins**:

```
kiosk override  →  organization default  →  platform default
```

Within a scope, the newest row whose `effective_from` has passed applies, so a
future-dated change sits dormant until its moment.

**Rows are never updated.** Publishing new rates inserts a new row. Two reasons:
a price change must not move a quote the customer is already looking at, and
last March's revenue report has to keep matching what people actually paid.

`print_jobs.base_price_per_page` snapshots the rate at job creation, which is
what makes the second guarantee hold — verified by test: changing prices after a
quote leaves the existing job untouched.

---

## 9. Audit

Every mutation is recorded: logins, organization and staff changes, permission
changes, pricing publications, exports. Entries carry the actor, the
organization, the IP and a JSON detail blob.

Passwords never appear in the log — verified by test.

Shop admins with `audit:read` see their own organization. `audit:read_all`
(super admin) sees everything.

---

## 10. Verification

Checked against a live Postgres:

- **78 checks** across auth, tenant isolation, roles, permission overrides,
  pricing scope, session rotation, lockout, suspension and soft delete
- **30 checks** on report arithmetic, the privacy boundary, CSV export, the
  rollup, and pricing reaching a real quote through the QR flow
- **13 unit tests** on the permission resolver
- Pi flow re-verified afterwards: **72 checks** still green

Bugs the live run caught that unit tests could not:

1. **Lockout was bypassable.** `locked_until` compared in JS on a non-UTC host
   read a future lock as past, so a locked account still accepted the correct
   password. Now compared in SQL.
2. **Refresh always 500'd.** The query aliased `au.id AS uid`, but the principal
   builder reads `id` — so it used the *token's* id and violated a foreign key.
3. **"Today" queried yesterday.** A Postgres `date` became a JS Date at local
   midnight; `.toISOString()` shifted it back across the UTC boundary.

---

## 11. Deployment

```bash
npm run migrate:sql -- 011_admin_dashboard.sql
npm run create-super-admin -- you@example.com "Your Name"
```

Optional environment variables (defaults shown):

```
ADMIN_ACCESS_TOKEN_TTL=15m
ADMIN_ACCESS_TOKEN_TTL_SECONDS=900
ADMIN_REFRESH_TOKEN_TTL_SECONDS=604800
ADMIN_LOGIN_RATE_LIMIT_MAX=10
```

`JWT_SECRET` is required in production and already enforced at boot.

---

## 12. Not built (deliberate)

- **Commission, settlements, payouts, Razorpay Route** — out of scope for the
  prototype. When it returns, write the settlement row inside the payment
  transaction, store money as integer paise, and derive net by subtraction.
- **Refunds** — `refunds:issue` exists and `razorpayService.refundPayment` is
  available, but no endpoint is wired. Worth doing early: paid jobs that cannot
  print are already a real situation.
- **MFA on super admin** — recommended before this holds real revenue.
- **Impersonation** ("view as shop") — useful for support; audit it loudly.
- **Data retention job** — decide how long sessions and documents live.
