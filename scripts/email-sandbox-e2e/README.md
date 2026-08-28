# Email sandbox e2e

End-to-end email tests against the **real** provider APIs. The main test suite
stubs every email fetch. This harness sends real requests through the production
delivery code and reports what each provider answered. It catches the one class
of bug that stubs cannot: request URLs, auth headers, and body shapes that drift
from what the providers accept.

The harness runs the production code directly — `sendEmail`
(`src/shared/email.ts`) for the single probe, and `sendBulkEmails`
(`src/shared/email/bulk.ts`) for the bulk probe. It does not boot the app server
or a browser, because outbound HTTP is the whole provider-facing surface for
email.

It is not a PR gate. See `.github/workflows/email-sandbox-e2e.yml` — it runs
nightly and on demand.

## Running

```bash
# Every provider leg (legs without secrets are skipped and reported):
nix develop -c deno task e2e:email

# One provider:
RESEND_API_KEY=re_... nix develop -c deno task e2e:email resend
```

Exit codes: 0 = executed (each leg sent or skipped), 1 = failed.

## What each leg sends

Each leg makes two real API calls with a unique run id in the subject:

1. A **single send** with an SVG attachment and a reply-to address — the request
   shape the registration and test emails use.
2. A **bulk send** with one recipient and an unsubscribe URL, through
   `sendBulkEmails`. This exercises the batch endpoint and the per-provider
   unsubscribe substitution.

A leg passes when the provider accepts both requests and the bulk reply accounts
for the probe message. `sendBulkEmails` reads Postmark's per-message results,
because its batch endpoint can answer 200 and still refuse a message inside it.
A reply that refuses the probe fails the leg. A reply that does not account for
it fails the leg too, because an unconfirmed message is not a sent one. The
harness reports what the production code found, and the refusal body when a
request fails. Each leg has a two-minute allowance. A provider that stalls
becomes a failed leg instead of a killed job, and the harness cancels the
request it left in flight.

## Secrets per leg

A leg runs only when its **on-switch** secret is set. A missing on-switch secret
skips the leg and reports the skip. This differs from the payment harness on
purpose: operators enable exactly the legs they hold credentials for. When the
on-switch secret is set, a missing or invalid companion secret fails the run,
because the operator clearly meant the leg to run.

| Leg          | On-switch               | Companions                                 | Recipient default                |
| ------------ | ----------------------- | ------------------------------------------ | -------------------------------- |
| `mailgun-eu` | `MAILGUN_EU_API_KEY`    | `MAILGUN_EU_FROM`, `MAILGUN_EU_TO`         | none — set `MAILGUN_EU_TO`       |
| `mailgun-us` | `MAILGUN_US_API_KEY`    | `MAILGUN_US_FROM`, `MAILGUN_US_TO`         | none — set `MAILGUN_US_TO`       |
| `postmark`   | `POSTMARK_SERVER_TOKEN` | `POSTMARK_FROM` (`POSTMARK_TO` optional)   | `test@blackhole.postmarkapp.com` |
| `resend`     | `RESEND_API_KEY`        | none (`RESEND_FROM`, `RESEND_TO` optional) | `delivered@resend.dev`           |
| `sendgrid`   | `SENDGRID_API_KEY`      | `SENDGRID_FROM` (`SENDGRID_TO` optional)   | `e2e@sink.sendgrid.net`          |

Every message goes to a safe recipient, so no person receives nightly mail:

- **Mailgun** has no public discard address. A sandbox domain only delivers to
  its authorized recipients, so authorize a throwaway address and set it as
  `MAILGUN_*_TO`. The from address decides the API domain, so `MAILGUN_*_FROM`
  must be an address on a domain in that account (the sandbox domain works). The
  two regions are separate accounts with separate API hosts, so each has its own
  secrets.
- **Postmark** documents `test@blackhole.postmarkapp.com`: the API accepts the
  message, shows it in Activity, and discards it. With a real server token,
  `POSTMARK_FROM` must be a verified sender signature. The public
  `POSTMARK_API_TEST` token also works as the on-switch and validates requests
  without an account.
- **Resend** documents `delivered@resend.dev` for delivery simulation and
  `onboarding@resend.dev` as the sender for accounts with no verified domain.
  Both are the defaults, so the API key alone enables the leg.
- **SendGrid** documents the `sink.sendgrid.net` domain: messages are accepted,
  then discarded. `SENDGRID_FROM` must be a verified sender identity.

`NTFY_URL` is optional; a failed run pings it, as the payment harness does.

## Reporting

The run prints one line per leg, appends a provider/outcome/detail table to the
GitHub Actions step summary, and publishes `result=executed` for the workflow's
verify step. A failed leg fails the run after every leg reported.

## Layout

```
scripts/email-sandbox-e2e/
  main.ts     entrypoint: target parse, leg loop, report, exit status
  legs.ts     the per-provider secret table and env resolution
  run.ts      the two probes, sent through the production email code
  report.ts   console lines, Markdown summary, verdict
```

The shared harness pieces live in `e2e-payments/src`: `log.ts` (output),
`notify.ts` (ntfy), `entry.ts` (the crash boundary), and `randomId`
(`config.ts`). `scripts/github-actions.ts` writes the step summary and the job
output for both harnesses and the mutation runner.
