# Environment variables

Runtime secrets are configured as **Bunny native secrets** in the Bunny Edge
Scripting dashboard. They are read at runtime via `process.env`. This page is
the reference for every variable the site and the build read. AGENTS.md keeps
only the three that every boot needs.

The optional static CDN is different: `CDN_URL`, `CDN_BUNNY_STORAGE_ZONE_NAME`,
`CDN_BUNNY_STORAGE_ZONE_KEY`, `CDN_BUNNY_STORAGE_HOST`, and
`CDN_BUNNY_PULL_ZONE_ID` are GitHub repository secrets used only while building.
When all five are set, the build uploads site-independent browser assets and
image-codec WASM under an immutable content-addressed path, purges the pull zone
with the existing `BUNNY_ACCESS_KEY` repository secret, verifies every public
object byte-for-byte, then bakes those public URLs and their CSP origin into the
edge script. They must not be added to the running Bunny script. With all five
absent, assets stay embedded; a partial set fails the build. Site-bound assets
such as `embed.js` and the dynamic `/order.js` body remain in each script. Use
the Storage API hostname shown on Bunny's Storage **Access** page for
`CDN_BUNNY_STORAGE_HOST` (for example, `storage.bunnycdn.com` or
`uk.storage.bunnycdn.com`).

## Required (configure in Bunny dashboard)

- `DB_URL` - Database URL (required, for example `libsql://your-db.turso.io`)
- `DB_TOKEN` - Database auth token (required for remote databases)
- `DB_ENCRYPTION_KEY` - 32-byte base64-encoded encryption key (required)

## Optional

- `PORT` - Server port (defaults to 3000, local dev only)
- `BUNNY_API_KEY` - Bunny API key (required for custom domain management, with
  `BUNNY_SCRIPT_ID`)
- `BUNNY_SCRIPT_ID` - Bunny Edge Script ID (required for custom domain
  management, with `BUNNY_API_KEY`)
- `STORAGE_ZONE_NAME` - Bunny CDN storage zone name (required for image uploads)
- `STORAGE_ZONE_KEY` - Bunny CDN storage zone access key (required for image
  uploads)
- `BACKUP_PAGE_SIZE` - Rows read per keyset page when dumping a table for backup
  (default 500). Each page is one libsql response, so this bounds the response
  size to stay under libsqld's "Response is too large" payload cap. Used by
  `deno task backup` and the admin Backups page; migrations no longer back up
  inline (the edge subrequest budget cannot fit a full dump), so backups are
  taken out-of-band.
- `MAIN_INSTANCE_KEY` - Shared secret authorizing the inter-instance
  site-credentials endpoint (`POST /instance/site-credentials`). When set on a
  builder/main instance, that endpoint returns built sites' DB URL + token to a
  caller presenting this key as a bearer token, so the upgrade workflow can back
  each site up to the builder's storage before deploying. The returned token is
  each site's own full-access credential (the same one the site runs with) —
  callers only read, but must treat the response as write-capable production
  secrets. The caller passes the release tier it is publishing as
  `?tier=alpha|beta|release` (a tier-less call defaults to `release` ⇒ the whole
  fleet, which is what the single-site `backup-site` action relies on); each
  site carries an `updates` channel and only the sites at that tier or more
  eager are returned (a `release` deploy reaches every site, `beta` reaches
  beta + alpha sites, `alpha` only alpha sites — an unknown tier is a 400). The
  response echoes the applied `tier` so a caller can confirm the server actually
  filtered: a pre-tier build ignores the query string and omits it, letting the
  canary workflow fail closed instead of fanning a non-release deploy out to the
  whole fleet. Unset `MAIN_INSTANCE_KEY` ⇒ the endpoint is disabled (404). The
  upgrade workflow receives the key as a run-time input, not a stored GitHub
  secret.
- `DENO_DEPLOY_TOKEN` - Deno Deploy organization access token. Required with
  `DENO_DEPLOY_ORG_ID` and `DENO_DEPLOY_ORG_SLUG` to build sites on Deno Deploy.
- `DENO_DEPLOY_ORG_ID` - Deno Deploy organization ID used by the app creation
  API.
- `DENO_DEPLOY_ORG_SLUG` - Deno Deploy organization slug used in each app's
  managed `<app>.<organization>.deno.net` production domain.
- `BUNNY_DNS_ZONE_ID` - Bunny DNS zone ID for subdomain registration (enables
  subdomain feature when set with `BUNNY_API_KEY`)
- `BUNNY_DNS_SUBDOMAIN_SUFFIX` - Suffix appended to user-chosen subdomain (for
  example `.tickets`)
- `NTFY_URL` - Ntfy endpoint URL for error notifications (for example
  `https://ntfy.sh/your-topic`). Sends domain and error code only, no personal
  or encrypted data.
- `SENTRY_URL` - Sentry DSN for server-side error reporting (for example a
  self-hosted Bugsink: `https://<key>@bugs.example.com/<project>`). When set,
  the same classified server errors that log to the console and ping ntfy are
  also captured by Sentry, with a real stack trace when the originating
  exception is available. Unset ⇒ Sentry is disabled (the SDK never
  initializes). The release is `chobble-tickets@<commit>`, matching the source
  maps the deploy workflows upload; readable (un-minified) traces additionally
  require the `SENTRY_AUTH_TOKEN`, `SENTRY_CLI_URL` (the instance base URL, for
  example `https://bugs.example.com/`), `SENTRY_ORG`, and `SENTRY_PROJECT`
  GitHub Actions secrets so the deploy can inject debug IDs and upload the maps.
  Without those secrets the deploy still works; traces just stay minified.
- `UPTIME_KUMA_URL` - Uptime Kuma 2.4 or newer base URL used by builder
  instances to inspect and add built-site scheduled maintenance monitors.
  Requires `CAN_BUILD_SITES=true`, `UPTIME_KUMA_USERNAME`, and
  `UPTIME_KUMA_PASSWORD`. A public host must use `https`. Cleartext `http` is
  allowed only for a local network address (loopback, private, CGNAT,
  link-local, or IPv6 unique-local).
- `UPTIME_KUMA_USERNAME` - Uptime Kuma username. Must be set with
  `UPTIME_KUMA_URL` and `UPTIME_KUMA_PASSWORD`.
- `UPTIME_KUMA_PASSWORD` - Uptime Kuma password. Must be set with
  `UPTIME_KUMA_URL` and `UPTIME_KUMA_USERNAME`.
- `UPTIME_KUMA_INTERVAL_MINUTES` - Optional positive whole number controlling
  how often new built-site monitors run. Defaults to `15`.
- `DEBUG_KEY` - Optional diagnostic key. `GET /health` returns a plain `Up :)`
  by default; a request with a matching `X-Debug-Key` header instead returns
  JSON build diagnostics (commit, build timestamp, server time) — non-private
  but useful to operators. Unset ⇒ verbose health disabled. The running build
  also records its commit into `settings.current_script_commit` on boot, so a
  backup carries the commit the site was on and a restore can surface which
  commit to redeploy (via `.github/workflows/restore-deploy.yml`).
- `BOTPOISON_PUBLIC_KEY` - Optional Botpoison public key (sent to the browser).
  The contact form works without it; setting it together with
  `BOTPOISON_SECRET_KEY` adds proof-of-work spam protection as a progressive
  enhancement. The owner still enables the form under Site → Contact and sets a
  business email.
- `BOTPOISON_SECRET_KEY` - Optional Botpoison secret key. Used server-side to
  verify contact form submissions when Botpoison is enabled. Never sent to the
  browser.
- `ADMIN_EMAIL_ADDRESS` - Enables a superuser recovery option in owner settings.
  The local-part (before `@`) must be a valid app username (2–32 characters,
  letters, numbers, hyphens, underscores). Email delivery must be configured
  before the superuser can be enabled. Also enables the owner-only **Support**
  page (`/admin/support`), where the operator can message this address.
- `SUPPORT_PAGE_TEXT` - Optional markdown shown at the top of the Support page
  (requires `ADMIN_EMAIL_ADDRESS`). Use literal `\n` for line breaks since Bunny
  secrets cannot hold real newlines. When unset, a placeholder note is shown
  instead. The support form below it (which delivers to `ADMIN_EMAIL_ADDRESS`)
  needs a business email to be set, like the public contact form.
- `SUPPORT_FORM_NAG_DAYS` - Optional positive integer (default `7`). For this
  many days after a support-form submission, the Support page shows a "you last
  submitted this form …" notice to discourage duplicate messages.
- `I18N_REPLACEMENTS` - Optional comma-separated `from|to` substring
  replacements that rebrand the **translatable copy** of every rendered message,
  for example `ticket|booking,attendee|guest`. Matching is case-insensitive and
  by substring (`ticket|booking` turns `tickets` into `bookings`), and the
  output copies the source word's capitalisation — `Ticket` → `Booking`,
  `ticket` → `booking` (only lowercase and title-case occur in real copy). It is
  applied to each message **template** once at load, and the rebranded template
  is compiled and cached, so rendering stays a plain ICU format with no per-call
  cost (important on a cold-booting edge runtime). It deliberately leaves alone:
  HTML tags and attributes (so link `href`s survive), `<code>` examples (literal
  route/CLI text), interpolated values such as a stored listing name (so "type
  this exact name" confirmations still match), and the fallback key returned for
  a missing translation. Avoid terms that collide with ICU keywords or
  placeholder names (`name`, `count`, `plural`, …).
- `APPLE_WALLET_PASS_TYPE_ID` - Apple Wallet Pass Type ID (for example
  `pass.com.example.tickets`)
- `APPLE_WALLET_TEAM_ID` - Apple Developer Team ID (for example `ABC1234567`)
- `APPLE_WALLET_SIGNING_CERT` - PEM-encoded signing certificate
- `APPLE_WALLET_SIGNING_KEY` - PEM-encoded signing private key
- `APPLE_WALLET_WWDR_CERT` - PEM-encoded Apple WWDR intermediate certificate

Apple Wallet can be configured via env vars (all 5 required) or via the admin
settings page. Admin settings (encrypted) take priority over env vars. If
neither is configured, the feature is disabled.

## Stripe Configuration

Stripe is configured via the admin settings page (`/admin/settings`), not
environment variables:

- Enter your Stripe secret key in the admin settings
- The webhook endpoint is automatically created in your Stripe account
- The webhook signing secret is stored encrypted in the database

Admin password and currency code are set through the web-based setup page at
`/setup/` and stored encrypted in the database.
