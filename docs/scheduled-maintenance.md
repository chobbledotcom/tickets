# Scheduled maintenance

Each site runs its own small database maintenance jobs. An external HTTPS
monitor can send requests on any schedule. New managed monitors default to one
request every 15 minutes:

```http
POST /scheduled HTTP/1.1
Authorization: Bearer <site key>
```

The request has no body. A successful run returns an empty `204`. A configured
site returns an empty `401` for a missing or wrong key. A site with no key, or a
non-`POST` request, returns an empty `404`. A system failure returns an empty
`503`. All responses use `Cache-Control: no-store`.

## Set Up A Site

Create a different 32-byte key for every independently deployed site:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Store it as the native `SCHEDULED_TASK_KEY` secret on that site. Never put the
key in a URL, monitor name, note, log, or plaintext database field. The owner
can read the local key on **Settings > Advanced**.

The built-site manager creates a different key for every child. It stores the
key in the child's native secret and in the builder's encrypted site data. Use
the child's **Scheduled maintenance** tab to set up an older child.

## Uptime Kuma

Use Uptime Kuma 2.4 or newer. Set all three credentials on the builder to manage
monitors from each built site's **Scheduled maintenance** tab:

- `UPTIME_KUMA_URL`
- `UPTIME_KUMA_USERNAME`
- `UPTIME_KUMA_PASSWORD`

Set `UPTIME_KUMA_URL` with `https://` for a host on the public internet. The
builder refuses cleartext `http://` for a public host, so the login cannot send
the Kuma credentials unencrypted. Cleartext `http://` works only for a local
network address: `localhost`, a loopback address, a private block (`10/8`,
`172.16/12`, `192.168/16`), the CGNAT block `100.64/10`, link-local, or an IPv6
unique-local address. A VPN address such as a Tailscale IP counts as local.

You can also set `UPTIME_KUMA_INTERVAL_MINUTES` to any positive whole number. It
defaults to `15`.

The tab connects to Uptime Kuma only while you view it or add a monitor. It
shows a monitor that already checks the site's `/scheduled` URL under the
**Chobble Tickets** group. If no monitor exists, set up the child's scheduled
task key first, then select **Add Uptime Kuma monitor**. The builder creates the
group when needed and adds an active `POST` monitor with the child's bearer key.
The key is sent in the request header, never in the monitor name or URL.

## Change A Child Key

Key rotation is not automatic. A host operator must replace a compromised key on
the child and in its Uptime Kuma monitor together.

## CDN Rules

Allow the monitor to reach `/scheduled` without a browser challenge, cached
response, redirect, or body rewrite. If the CDN has an allowlist, add the
monitor there.

Rate-limit `/scheduled` at the CDN before requests reach the edge script. The
application deliberately does not keep a request counter for rejected calls:
doing so would let unauthenticated traffic consume database subrequests before
authentication. Keep the limit high enough for the monitor's retries, but far
below a general API traffic rate.
