# Request security: client IP, redirects, and attachment caches

This plan closes three findings from the security scan of 2026-07-29: #2201,
#2202, and #2203. The three changes are independent. They ship as one pull
request with one commit for each issue.

## Current-system value

| Issue | What becomes better                                                                                                                                                                                                                       | Production path                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2201 | Each visitor gets a rate-limit row of their own. Today every production request records the client IP `direct`, so one visitor can lock the login, the bookings, the ticket links, the address lookup, and the API keys for all visitors. | `src/edge.ts`, `src/deploy.ts`, and `src/index.ts` into `serveHandler`, then every IP rate limiter: login, booking, ticket token, address lookup, API key |
| #2202 | An SMS gateway redirect to a different host no longer receives the message body or the Basic credentials of the gateway account.                                                                                                          | `sendEncryptedMessage` in `src/shared/sms/gateway.ts`, the only caller of `fetchTextFollowingSafeRedirects`                                               |
| #2203 | A shared cache no longer keeps a protected attachment after the signed link expires or the booking stops.                                                                                                                                 | `GET /attachment/:id` in `src/features/attachments.ts`                                                                                                    |

Registration webhooks already send with `redirect: "manual"` and never follow a
redirect (`sendWebhook` in `src/shared/webhook/delivery.ts`). A redirect answer
is a `rejected` delivery. #2202 names webhooks, but they need no change.
`test/shared/webhook/delivery/send.test.ts` already pins that behaviour.

## Trusted facts

| Input                                            | Trusted? | Basis                                                                                                                                                                               |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deno `ServeHandlerInfo.remoteAddr` (Deploy, dev) | Yes      | The runtime reads it from the TCP connection. A client cannot set it. On Deno Deploy it is the client address.                                                                      |
| Bunny `x-real-ip` request header                 | See Q1   | Bunny documents `X-Real-IP` as the client IP that the CDN adds. Bunny does not document that the edge replaces a value that the client sends. Bunny gives the handler nothing else. |
| Any other request header (`x-forwarded-for`)     | No       | The client can set it.                                                                                                                                                              |
| SMS gateway `location` header                    | No       | The gateway host or anything between us and it can set it.                                                                                                                          |
| Signed attachment URL (`a`, `exp`, `sig`)        | Yes      | `verifyAttachmentUrl` checks the signature and the expiry on each request.                                                                                                          |

## Valid states

### Client IP (#2201)

The client IP is one string for each request. The entry point reads it once,
before the router, and `runWithClientIp` keeps it for the request.

- A network request always carries a real address. A missing address on a
  network request is a platform fault. The Bunny entry throws inside the logged
  503 guard (see Q2). Deno types `remoteAddr` as a TCP address, so it always has
  a host name.
- An in-process call to `handleRequest` (the test suite) carries no connection.
  It records `direct`, as it does today. No production path calls
  `handleRequest` without an address after this change. `serveHandler` requires
  the address in its type.

`ServerContext` and `getClientIp(request, server)` go away. Every limiter reads
`getRequestClientIp()`. The `server` parameter goes away from the router, the
route handlers, and the API guards. This gives one source for the client IP
instead of two.

### Redirects (#2202)

| Redirect target                      | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Same origin (scheme, host, and port) | Follow with the same request, as today    |
| Different origin                     | Throw `Unsafe redirect URL`. Send nothing |
| No `location`                        | Return the redirect answer, as today      |
| More than five hops                  | Throw `Too many redirects`, as today      |

A cross-origin redirect fails closed. No caller has a reason to follow one. The
server-fetch URL policy reads only the scheme and the host. A same-origin hop
therefore passes it too, and the per-hop policy check goes away.

### Attachment response (#2203)

The download answer sends `cache-control: private, no-store`. The handler stops
setting its own header. The middleware then applies its default for dynamic
answers, which is `private, no-store`. This deletes the only public cache header
on a response that depends on a signed link.

## Commands and events

| Starting state             | Command or event                                 | Required result                                                |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Bunny request              | `x-real-ip: 198.51.100.4`                        | Every limiter uses `198.51.100.4`                              |
| Bunny request              | No `x-real-ip`                                   | Logged 503. See Q2                                             |
| Deno request (Deploy, dev) | `remoteAddr` is TCP `203.0.113.9`                | Every limiter uses `203.0.113.9`                               |
| Two clients, A then B      | A fails the login five times, then B tries       | B is not locked out. The login table holds one row for each IP |
| SMS send                   | Gateway answers 307 to another host              | Throw `Unsafe redirect URL`. The other host gets no request    |
| SMS send                   | Gateway answers 307 to a path on the same origin | Follow once with the same body and credentials                 |
| Registration webhook       | Target answers 302 to another host               | Delivery is `rejected`. No second request                      |
| Attachment download        | Valid signed link, active booking                | 200 with `cache-control: private, no-store`                    |

## Failure table

| Work completed | Failure                               | Required result                                                   | Retry owner            |
| -------------- | ------------------------------------- | ----------------------------------------------------------------- | ---------------------- |
| Nothing        | Entry point finds no client address   | The request fails and the error log shows the cause               | None. A platform fault |
| Nothing        | SMS gateway redirects to another host | `sendEncryptedMessage` throws, as it does for an unsafe hop today | The SMS outbox         |
| Nothing        | Attachment download fails             | Unchanged                                                         | The attendee           |

## Retry and replay table

None. No change adds a write, a claim, or a stable identity. The SMS outbox
keeps its current retry rules for a thrown send.

## Concurrency table

None. The client IP is request-scoped. The limiter writes do not change.

## Owner choices

**Q1. Trust Bunny `x-real-ip`?** If Bunny passes a client-supplied `x-real-ip`
unchanged, an attacker can send a new value on each request and escape every
limiter. Today the shared `direct` row at least limits the whole site. I
recommend that we trust the header, but only after a check on a staging site
before merge:

1. Deploy the branch to a staging Bunny site.
2. Send five wrong logins with the header `X-Real-IP: 192.0.2.1`.
3. Send one wrong login with the header `X-Real-IP: 192.0.2.2`.
4. If step 3 shows the lockout message, Bunny replaces the header. Merge.
5. If step 3 shows the normal login error, Bunny passes the header through. Do
   not merge. Redesign #2201.

**Q2. No `x-real-ip` on a Bunny request.** I recommend a throw, because the
header is the platform contract and a default hides a broken contract. The
alternative is the shared `direct` row. The staging check in Q1 also proves that
the header arrives.

## Security and privacy

- The client IP stays request-scoped. It goes into the limiter tables as today.
  No new log line and no new column hold it.
- After #2202 the SMS gateway credentials and the encrypted message body go only
  to the origin that the owner configured.
- After #2203 no shared cache holds an attachment. Each download checks the
  signature, the expiry, and the booking again.
- Out of scope, for a separate issue: `WALLET_CACHE_CONTROL`
  (`public, s-maxage=3600`) lets a CDN serve a wallet pass for up to one hour
  after its booking stops.

## Challenge

- A request comes through Bunny with a forged `x-real-ip`: Q1 decides it before
  merge.
- A redirect to the same host but another port or scheme: the origin differs, so
  the code refuses it.
- A 303 answer on the SMS POST: same-origin behaviour does not change in this
  pull request.
- A scheduled request: the handler does not read the address, because no
  scheduled job uses it.
- A test that calls `handleRequest` with no address still gets `direct`, so the
  suite keeps its limiter fixtures.

## Pull request

One pull request on `security-scan-request-fixes`, based on `main`. It closes
#2201, #2202, and #2203.

| Commit | Source files                                                                                                                                                                | Source-line budget |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| #2203  | `src/features/attachments.ts`                                                                                                                                               | −1                 |
| #2202  | `src/shared/safe-fetch.ts`                                                                                                                                                  | +10                |
| #2201  | `src/serve-app.ts`, the three entry files, `request-scopes.ts`, `url.ts`, `types.ts`, `router.ts`, the route and API files that pass `server`, and the five limiter callers | +40, −60           |

No database or provider call is added.

## Tests

| Contract row                 | Test                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bunny address to limiter     | `test/lib/serve-app.test.ts`: the Bunny handler with two `x-real-ip` values gives two login rows                                                             |
| Deno address to limiter      | Same file: the Deno handler with two `remoteAddr` values gives two login rows                                                                                |
| Entry files use the adapters | `test/edge.test.ts`, `test/deploy.test.ts`, `test/index.test.ts`: each entry serves through its adapter                                                      |
| Missing address              | Same file: the Bunny handler logs the error and answers 503                                                                                                  |
| Limiters read the scoped IP  | Move the `server` stub tests in `url.test.ts`, `request-scopes.test.ts`, `booking-inputs.test.ts`, and `auth/login.test.ts` to an address on `handleRequest` |
| Cross-origin redirect        | `test/shared/safe-fetch.test.ts`: another host, another port, and a subdomain each throw after one request                                                   |
| Same-origin redirect         | Same file: the second request carries the original body and headers                                                                                          |
| SMS credentials stay         | `test/shared/sms/gateway.test.ts`: a cross-origin 307 sends one request only                                                                                 |
| Webhook does not follow      | The test that exists in `send.test.ts` (no change)                                                                                                           |
| Attachment cache header      | `test/integration/attachment-route.test.ts`: exact `cache-control: private, no-store`                                                                        |

Each regression test must fail on `main` for the reported reason before the fix.
