# AIRA reminder scheduler — deployment and delivery contract

## Verified deployment limit (2026-10-14)
The current Vercel Hobby project rejected a `* * * * *` cron configuration with
`cron_jobs_limits_reached`: Hobby supports daily cron, not every-minute jobs.
A daily-only cron is **not** an acceptable implementation for user-local 10:00 AM,
especially with different IANA timezones.

## How reminders work
- Browser sends its IANA timezone to the server; explicit timezone overrides it.
- Server parses explicit reminder objective/cadence/time (no 9 AM default).
- A Postgres advisory transaction lock prevents duplicate schedules for one principal,
  objective, cron expression, trigger, and timezone.
- The scheduler calculates due local slots with `cron-parser` timezone support.
- Exactly one run is claimed per automation and scheduled instant (database unique index).
- Due reminders create durable, principal-scoped `automation_notifications` records.
- AIRA's bell inbox polls and displays those records while the web app is open or when reopened.
- **Email, mobile push and OS-level notifications are not implemented.** Do not claim those.

## Required external scheduler
On Vercel, background `setInterval` execution is disabled and serverless functions freeze.
To enable live reminders, arrange a secure **once-per-minute** HTTP scheduler:

1. Use Vercel Pro Cron with `GET /api/automations/cron/execute` at `* * * * *`,
   or an independently authenticated equivalent scheduler (e.g. a Cloudflare Worker Cron).
2. Configure `CRON_SECRET` as a random 32+-character secret in the appropriate
   Vercel environment. Do not check it into source control.
3. Ensure the scheduler sends `Authorization: Bearer <CRON_SECRET>` on the GET request.
   Vercel Cron automatically supplies it when configured according to Vercel's contract.
4. Verify repeated successful minute ticks and durable inbox delivery on staging.
5. Only after verification set `AIRA_SCHEDULER_ACTIVE=true` in the target Vercel
   environment. Without both this flag and `CRON_SECRET`, the application correctly
   refuses to schedule new cloud reminders instead of promising something impossible.
6. Test one daily reminder in the actual target IANA timezone, including DST for
   applicable zones, clock boundaries, duplicate suppression, and server restart.
7. Confirm production migrations are approved, `prod-release` CI is passing, and
   GO LIVE approval is granted before changing Production.

## Production acceptance matrix
- [ ] All required database migrations applied without destructive data changes
- [ ] External minute-precision scheduler active and authenticated
- [ ] Anonymous GET/POST cron attempts denied
- [ ] Correct user-local 10:00 AM due slot, no UTC offset mistakes
- [ ] Exactly one automation run and in-app notification for duplicate cron invocations
- [ ] Two user principals cannot access each other's reminders
- [ ] Refresh/reopen AIRA shows the durable reminder
- [ ] Explicit disclosure that off-app email/push notifications are not supported
- [ ] Failed notifications observable, retried safely
- [ ] Cron outage, DST transitions and repeat timing exercised

## Important
Existing reminders created by the old parser may be inaccurate or duplicated.
Do not bulk-delete or mutate them without authorization. Provide affected users
an opportunity to review/disable old schedules when the Automations UI is complete.
