# Branch previews

Each open pull request from this repository gets its own Tickets site on the
staging Bunny account. The workflow is `.github/workflows/preview.yml`. The
commands are in `scripts/preview.ts`.

## What happens

| Event                              | Result                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| A pull request opens or reopens    | The workflow creates a database, a script, and a pull zone.             |
| A push to the branch               | The workflow deploys the new build. The database is not reset.          |
| The pull request closes or merges  | The workflow deletes the script, its pull zone, and the database.       |
| A pull request from a fork         | Nothing happens. A fork run has no secrets.                             |

A preview that is not set up shows the "Not Activated" page. Open `/setup` on
the preview address to set it up.

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
| `CDN_STAGING_URL`                         | Static asset CDN for the build. Set all five CDN secrets or none. |
| `CDN_BUNNY_STAGING_STORAGE_ZONE_NAME`     | Static asset storage zone name.                           |
| `CDN_BUNNY_STAGING_STORAGE_ZONE_KEY`      | Static asset storage zone key.                            |
| `CDN_BUNNY_STAGING_STORAGE_HOST`          | Storage API host of that zone.                            |
| `CDN_BUNNY_STAGING_PULL_ZONE_ID`          | Pull zone that the build purges after an upload.          |

The workflow creates these secrets on each new preview:

- `DB_URL` and `DB_TOKEN` for the new database
- `DB_ENCRYPTION_KEY` and `SCHEDULED_TASK_KEY`, which are random
- `BUNNY_SCRIPT_ID`

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
- The delete step deletes the database last. A missing resource counts as
  deleted, so a rerun finishes the work.

## When a run fails

1. Read the job log. Each Bunny error names the call and the status.
2. Push again, or run the failed job again. Every step is safe to repeat.
3. If the delete job names a pull zone, delete that pull zone by hand in the
   Bunny dashboard. Then run the job again.
