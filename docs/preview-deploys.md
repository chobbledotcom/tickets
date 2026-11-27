# Branch previews

Each open pull request from this repository gets its own Tickets site on the
staging Bunny account. The workflow is `.github/workflows/preview.yml`. The
commands are in `scripts/preview.ts`.

## What happens

| Event                              | Result                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| A pull request opens or reopens    | The workflow creates a database, a script, and a pull zone. It sets up the site.  |
| A push to the branch               | The workflow deploys the new build and publishes the branch guide videos. The database is not reset. |
| The pull request closes or merges  | The workflow deletes the Stripe webhooks, the script, its pull zone, and the database. |
| A pull request from a fork         | Nothing happens. A fork run has no secrets.                                       |

The pull request shows a "View deployment" link for the `preview`
environment. The job summary shows the same address. The address ends in
`.b-cdn.net`, the stable name of the site.

## Guide videos

The preview deploy job publishes the branch guide videos before the build. The
job has the preview environment, so it reads the staging CDN secrets directly.
The preview build bakes the returned map into the page.

The job checks each guide on its own. A guide whose anchors still match reuses
its CDN object. A guide whose anchors changed is recorded, rendered, and
uploaded again. A failed publish stops the preview deploy.

The uploaded videos stay on the staging CDN after the preview closes. Their
names come from the video bytes, so a later preview can reuse them.

## Setup of a new preview

The workflow sets up a new preview through its own pages, as the owner does:

1. It opens `/setup` and completes it with the shared owner login.
2. It signs in with that login.
3. It saves the sandbox keys of SumUp, Square, and Stripe, in that order.
   Stripe stays the active payment provider.

Sign in to the preview with `PREVIEW_OWNER_USERNAME` and
`PREVIEW_OWNER_PASSWORD`.

The workflow saves the providers once, in the run that completes the setup.
The app refuses to switch back to a provider that already holds keys, so a
second pass cannot continue a half-made setup. A preview that is already set
up is left as it is, even when a person set it up by hand. If a save fails, the
job log names the provider and shows the reason that the site gave. Fix the
setting in the admin settings, or close the pull request and open it again.

The Stripe save registers a webhook for the preview in the sandbox Stripe
account. The cleanup deletes that webhook when the pull request closes. A
preview only accepts a Stripe test key. A key that does not start with
`sk_test_` stops the run.

## Names

One branch has one preview. The script name is
`Tickets - preview-<slug>-<hash>`. The database name is `pv-<long-hash>`.
Bunny allows 16 characters at most in a database name, so the database name
has no slug.

- `<slug>` is the branch name in lower case. Each run of other characters
  becomes one dash. The slug has 30 characters at most.
- `<hash>` is the first 6 hex characters of the SHA-256 of the exact branch
  name. Two branches that give one slug still get two previews.
- `<long-hash>` is the first 12 hex characters of the same SHA-256.

The delete step only touches a script whose name starts with
`Tickets - preview-`.

## Secrets

All secrets are in the `preview` environment. That environment must allow
every branch.

| Secret                                    | Use                                                       |
| ----------------------------------------- | --------------------------------------------------------- |
| `BUNNY_STAGING_ACCOUNT_KEY`               | The staging Bunny account. The scripts use it as `BUNNY_ACCESS_KEY`. |
| `STAGING_STORAGE_ZONE_NAME`               | Becomes `STORAGE_ZONE_NAME` on the preview.               |
| `STAGING_STORAGE_ZONE_KEY`                | Becomes `STORAGE_ZONE_KEY` on the preview.                |
| `HOST_EMAIL_PROVIDER`                     | Copied to the preview. The preview sends real mail.       |
| `HOST_EMAIL_API_KEY`                      | Copied to the preview.                                    |
| `HOST_EMAIL_FROM_ADDRESS`                 | Copied to the preview.                                    |
| `PREVIEW_OWNER_USERNAME`                  | The owner login that the setup creates.                   |
| `PREVIEW_OWNER_PASSWORD`                  | The owner password that the setup creates.                |
| `STRIPE_SECRET_KEY`                       | Stripe sandbox key. It must start with `sk_test_`.        |
| `SQUARE_ACCESS_TOKEN`                     | Square sandbox access token.                              |
| `SQUARE_LOCATION_ID`                      | Square sandbox location.                                  |
| `SUMUP_API_KEY`                           | SumUp sandbox key.                                        |
| `SUMUP_MERCHANT_CODE`                     | SumUp sandbox merchant code.                              |
| `CDN_STAGING_URL`                         | Static asset and guide video CDN for the build. Set all five CDN secrets or none. |
| `CDN_BUNNY_STAGING_STORAGE_ZONE_NAME`     | Static asset and guide video storage zone name.           |
| `CDN_BUNNY_STAGING_STORAGE_ZONE_KEY`      | Static asset and guide video storage zone key.            |
| `CDN_BUNNY_STAGING_STORAGE_HOST`          | Storage API host of that zone.                            |
| `CDN_BUNNY_STAGING_PULL_ZONE_ID`          | Pull zone that the build purges after an upload, and that serves the guide videos. |

The payment keys are not script secrets. The setup enters them in the admin
settings, where the app stores them in its database.

The workflow creates these secrets on each new preview:

- `DB_URL` and `DB_TOKEN` for the new database
- `DB_ENCRYPTION_KEY` and `SCHEDULED_TASK_KEY`, which are random
- `BUNNY_SCRIPT_ID`
- `BUNNY_API_KEY`, a copy of the staging account key. The site needs it to
  manage its own CDN, such as a custom domain.

A preview never receives `MAIN_INSTANCE_KEY`, the production Bunny key, or the
production storage zone key.

Anyone who can push a branch to this repository can read these secrets,
because a pull request run uses the workflow file of the pull request. The
staging account limits the Bunny risk. The host mail key is not limited. A
preview can send real mail from the host address.

## Rules that keep the data safe

- A secret that exists on a preview is never written again. A new
  `DB_ENCRYPTION_KEY` makes the kept database unreadable.
- The build is published only after every secret exists.
- A run that stopped half way continues on the next push. It finds each
  resource by name and does not make a second copy.
- The delete step deletes the Stripe webhooks first and the database last. A
  missing resource counts as deleted, so a rerun finishes the work.

## When a run fails

1. Read the job log. Each Bunny error names the call and the status.
2. Push again, or run the failed job again. Every step is safe to repeat,
   except the provider setup that the section "Setup of a new preview"
   describes.
3. If the delete job names a pull zone, delete that pull zone by hand in the
   Bunny dashboard. Then run the job again.
