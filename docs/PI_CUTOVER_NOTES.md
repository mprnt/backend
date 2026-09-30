# Raspberry Pi cutover — coordination notes

Send this to whoever owns the Pi client. The full contract is in
[RASPBERRY_PI_INTEGRATION.md](./RASPBERRY_PI_INTEGRATION.md).

## What changed, in one paragraph

The printer API moved from `/api/v1/printer/*` to `/api/v1/queue/*` and now requires
per-device credentials. The old `/printer/*` routes are **deleted** — any client
calling them gets 404. Jobs are also now claimed under a lease, so a printer that
goes quiet has its job returned to the queue automatically.

## Breaking changes for the Pi

| Before | Now |
|---|---|
| `GET /printer/next-job?printerId=X` | `POST /queue/poll` with credential headers |
| `POST /printer/job-status` (jobId in body) | `POST /queue/jobs/{jobId}/status` |
| `POST /printer/heartbeat` | `POST /queue/heartbeat` |
| `POST /printer/register` | `POST /queue/printers/enroll` (once), then `/queue/printers/register` |
| No authentication | `X-Printer-Id` + `X-Printer-Key` on every call |
| Job document fetched via a second API call | `documentUrl` (pre-signed, 15 min) comes with the job |
| `jobId` ambiguous between two tables | `jobId` is always `print_jobs.id`, a UUID v4 |
| `failed` accepted with no reason | `errorCode` is **required** when reporting `failed` |

## Cutover sequence

Do these in order. Steps 1–2 are safe to run while the old code is still live.

1. **Run the migration against production.** It is additive only
   (`ADD COLUMN IF NOT EXISTS`), so the currently-deployed code keeps working:
   ```bash
   npm run migrate:sql -- 010_printer_auth_and_queue_hardening.sql
   ```
   It is idempotent — re-running it is harmless.

2. **Set the new variables in Railway** (the backend will refuse to boot without
   the first two):
   - `JWT_SECRET`
   - `PRINTER_PROVISIONING_TOKEN`
   - `PRINTER_JOB_LEASE_SECONDS=900` (optional, this is the default)
   - `PRINTER_DOCUMENT_URL_TTL_SECONDS=900` (optional)
   - `PRINTER_HEARTBEAT_TIMEOUT_SECONDS=180` (optional)

3. **Deploy the backend.** At this moment any Pi still running the old client
   starts getting 404/401. Expect a gap until step 4 completes.

4. **Enroll each printer once** and put its key on the device:
   ```bash
   curl -X POST https://<domain>/api/v1/queue/printers/enroll \
     -H 'Content-Type: application/json' \
     -H "X-Provisioning-Token: $PRINTER_PROVISIONING_TOKEN" \
     -d '{"printerId":"RPI_M001_01","kioskId":"<kiosk-uuid>","name":"Kiosk M001 - Printer A",
          "capabilities":{"supportsColor":false,"supportsDoubleSided":true,
                          "maxCopies":50,"supportedPaperSizes":["a4"]}}'
   ```
   The response contains `apiKey` **once**. Store it in `/etc/mprnt/printer.env`
   (mode `0640`) on the device. It cannot be retrieved later — only rotated.

5. **Deploy the updated Pi client** and confirm a heartbeat arrives:
   ```sql
   SELECT printer_id, status, last_heartbeat FROM printers;
   ```

6. **Run one real job end to end** and watch it reach `completed`.

## Rollback

The migration is additive, so rolling the *code* back to the previous release
works without touching the schema. The new columns simply sit unused. Do not drop
them — a forward fix is cheaper than a schema rollback.

## Getting kiosk UUIDs

`kioskId` is the UUID primary key, not the short code like `M001`:

```sql
SELECT id, kiosk_id, name FROM kiosks ORDER BY kiosk_id;
```

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Backend won't boot | `JWT_SECRET` / `PRINTER_PROVISIONING_TOKEN` unset | Set them in Railway |
| Pi gets 401 on every call | Wrong or missing key | Re-check `/etc/mprnt/printer.env`, or rotate the key |
| Pi gets 403 | Credentials revoked, or reporting on a job it does not hold | Check `printers.revoked_at` |
| Enrollment returns 409 | Printer already enrolled | Rotate instead — Printers page in the admin dashboard, or `POST /admin/printers/{printerId}/rotate-key` |
| Jobs stay `queued`, never claimed | No online printer matches the job's colour/duplex needs at that kiosk | Check `printers.status` and capabilities |
| Job stuck `printing` then reappears | Lease expired — the Pi stopped reporting | Expected recovery; check the Pi's logs for why it went quiet |
