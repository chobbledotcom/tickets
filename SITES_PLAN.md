# Website and executable product specification plan

Status: proposed

This plan moves `chobbledotcom/tickets-site` into this repository at `website/`, isolates its build and
deployment from the ticket application, and makes Cucumber Features the shared source for user stories,
observable product rules, executable acceptance examples, and promotional content checks.

The detailed first Cucumber implementation is in `CUCUMBER_MVP.md`.

## Decisions

1. Preserve the promotional site's Git history under `website/`.
2. Keep it as a Bun/Eleventy project. Do not fold it into the Deno app or edge bundle.
3. Build and deploy the website only when `website/**` changes. Changes to the website workflow itself are the
   deliberate exception, so workflow edits can prove that they work.
4. Keep canonical behavior specifications in root `specs/**/*.feature`.
5. Use the official Cucumber runner programmatically under pinned Deno 2.5.6. Do not add Node, run Cucumber
   through Bun, or create a custom Gherkin runner.
6. Schema-tize stories as `Feature -> Rule -> Scenario`, add stable IDs and scope through validated tags, compile
   them to Pickles, and use Cucumber Messages NDJSON as the generated catalog and execution evidence.
7. Replace existing narrative integration/e2e cases when a Cucumber story covers them. Do not retain wrappers or
   parallel versions.
8. Keep direct TypeScript tests for pure logic, property tests, schemas, SQL/transactions, migrations, protocol
   contracts, and test infrastructure. They are smaller and stronger than Gherkin for those jobs.
9. Pin the website template, Bun, Cucumber, Gherkin, Messages, and all build dependencies.

## Goals

- Keep `https://tickets.chobble.com` and every intended public path working.
- Preserve Bunny production deployment, branch deployment to staging, IndexNow, failure notification, and the
  scheduled Google review import.
- Run a complete read-only website quality gate before deployment.
- Avoid app builds, app deployments, docs deployments, and website builds when their inputs did not change.
- Give every durable behavior a stable story ID, rule IDs, actors, editions, owner, risk, examples, and results.
- Make the same authored Rules readable by people, executable by Cucumber, and consumable by website LLM checks.
- Detect undefined stories, stale website claims, contradictions, wrong scope, and overstatement.
- Use passing scenarios, direct coverage, and mutation testing as evidence rather than an LLM reading test code.

## Non-goals

- Do not generate promotional paragraphs from stories in the first version.
- Do not treat website copy, READMEs, or comments as primary evidence for behavior.
- Do not force prices, company records, legal claims, or volatile competitor claims into fake Given/When/Then
  scenarios. Add a small typed reference format later only when a real claim cannot be observable behavior.
- Do not make deployment depend on a live LLM call. Semantic checks happen before merge.
- Do not convert the whole direct test suite to Cucumber.
- Do not retain separate local and CI build mechanisms for the website.

## Current findings

The source site was inspected at commit `70c980a`.

- It has 115 Markdown pages, 65 tracked product screenshots, Eleventy data and overrides, Bun scripts, one
  direct site test, and a `chobble-template` submodule.
- Local builds use template commit `c655c5b8`; production fetches mutable template `main`. They already produce
  different output.
- Deployment delegates to mutable `chobble-client@main`, which assumes the site is at repository root and runs
  on every push.
- Production skips the template's full link check. Site precommit skips tests, and `bun run test` misses the
  site's own test because it is copied outside the configured test root.
- Biome and jscpd are fetched through unpinned `bunx` commands.
- The review workflow currently fails because `google_place_id` is missing. It writes a collection that the
  hand-written review page does not clearly consume.
- `.pages.yml` is stale and assumes all content is at repository root.
- Secrets, environments, branch rules, and other repository settings do not move with files.

Known content drift gives the first stories and checks useful targets:

- The backup page says restore runs in the admin panel. The app only restores through `deno task restore`.
- Some documentation omits SumUp although Stripe, Square, and SumUp are supported.
- Existing crypto documentation describes the password hash inaccurately.
- "No Chobble per-ticket platform fee" can be overstated as "no fees", although organisers may add a fee.
- Refund behavior needs a best-effort qualification because provider failures are recorded and retried.
- EU hosting copy must distinguish app hosting from database replica locations.

## Target layout

```text
.
|-- .github/workflows/
|   |-- website.yml
|   `-- update-website-reviews.yml
|-- specs/
|   |-- owners.json
|   `-- <domain>/<story>.feature
|-- scripts/specs/
|-- test/specs/
|   |-- steps/
|   `-- support/
|-- test/scripts/specs/
|-- website/
|   |-- AGENTS.md
|   |-- _data/
|   |-- _includes/
|   |-- assets/
|   |-- chobble-template/
|   |-- css/
|   |-- images/
|   |-- pages/
|   |-- scripts/
|   |-- test/
|   |-- biome.json
|   |-- bun.lock
|   |-- bunfig.toml
|   |-- package.json
|   `-- README.md
|-- .gitmodules
`-- .pages.yml
```

Generated Cucumber Messages, HTML, and JUnit reports are ignored build artifacts. Workflows and Pages CMS
configuration remain at repository root because GitHub does not discover nested copies.

## Import specification

### Preserve history and establish a baseline

Use a temporary clone and `git filter-repo --to-subdirectory-filter website`, then merge the rewritten branch
with `--allow-unrelated-histories`. Do not copy a working tree or squash the import. Rewritten paths preserve
useful blame and page dates.

Before import:

1. Record the source and submodule commits in the migration PR.
2. Record the production sitemap, redirects, response statuses, page dates, and public asset hashes.
3. Build with the template revision production currently uses.
4. Move the submodule to that tested revision so local and production start from one baseline.
5. Export Actions secret names and environment settings, never their values.

Import tracked content, data, includes, scripts, tests, assets, screenshots, package files, and
`.image-cache/.keep`. Exclude `.git`, `.build`, `_site`, `node_modules`, `.direnv`, `.jscpd-report`, local
screenshots, environment files, caches, and expired Actions artifacts.

### Integrate repository-level files

- Replace `website/.gitmodules` with a root entry for `website/chobble-template`. Keep the template as a gitlink.
- Move and adapt both workflows into root `.github/workflows/`.
- Replace `website/.pages.yml` with root `.pages.yml`; prefix paths with `website/` and regenerate the schema
  from real collections and block types instead of retaining stale product, menu, and news entries.
- Add Bun and `vips` to the root Nix shell, then remove nested `website/flake.nix` and `website/.envrc`. The old
  shell's automatic `git pull` must not survive.
- Keep `website/.gitignore` for `.build/`, `_site/`, and local Bun output.
- Move the useful content guide into scoped `website/AGENTS.md` and remove duplicate `CLAUDE.md`. State that
  promotional copy belongs in Markdown and website data, not the app locale catalog.
- Rewrite the stale website README and add `website/` to root `.dockerignore`.

### Fix path assumptions

- Run all site commands with `website/` as their working directory.
- Change screenshot scenario discovery from sibling `../tickets-4` to this repository's root.
- Change app examples from `../tickets-site/...` to `website/...`.
- Make scripts derive paths from their module. Fix `migrate-block-schema.js`, which currently uses process CWD.
- Point template Git-date lookup at checked-out `website/` and test a page with known history.
- Keep published links root-relative. Only source paths change.

## One website build

The checked-in `website/chobble-template` revision is the only template input. CI must not fetch another template.

Pin one Bun version in `website/package.json`, root `flake.nix`, and Actions. Start with the template's current
supported version, 1.3.6, and prove it before changing the pin. Add Biome and jscpd to `bun.lock`; declare
`js-yaml` if its script remains, otherwise delete the dead script.

| Command | Contract |
| --- | --- |
| `bun --cwd website run serve` | Serve the same merged source used by CI |
| `bun --cwd website run lint` | Read-only format and lint check |
| `bun --cwd website run cpd` | Enforce zero duplicated website script code |
| `bun --cwd website run test` | Run direct site and merged-site integration tests |
| `bun --cwd website run build` | Use the pinned template and run link checks |
| `bun --cwd website run precommit` | Run lint, CPD, tests, and build without edits |

Fix the test layout so the screenshot text test runs. Coverage must include the production module under test
instead of excluding every script. Keep generated `website/_site/` ignored.

## Automation

### Change matrix

| Change | Required `test` | App deploy/docs | Website build | Website deploy | Story/content checks |
| --- | --- | --- | --- | --- | --- |
| `website/**` PR | lightweight success | no | yes | no | affected content |
| `website/**` branch push | lightweight success | no | yes | staging | affected content |
| `website/**` on `main` | lightweight success | no | yes | production | affected content |
| `specs/**` only | affected Cucumber | no | no | no | affected stories/content |
| App files only | full app suite | as today | no | no | Cucumber stories |
| Website workflow | lightweight success | no | yes | eligible pushes only | as needed |
| Manual website run | unchanged | no | yes | selected target | full audit |

The branch-protection job named `test` must always exist. Do not skip its whole workflow with `paths-ignore`.
Classify `base...HEAD`, skip expensive app steps only when every path belongs to known website/spec areas, and
run the full app suite for unknown root paths or mixed app changes.

Add `paths-ignore` for `website/**`, `specs/**`, `.pages.yml`, and website workflow files to non-required app
staging and docs deploy workflows. Mixed commits still run both systems.

### Website workflow

`website.yml` triggers for `website/**`, `specs/**`, and itself on push and pull request, plus manual dispatch.
Spec-only events enter story/content validation but skip every website build and deployment job.

1. `changes` computes website, story, support, and website-content changes from the merge base.
2. `stories` validates Gherkin, runs affected Pickles, emits Messages, and runs affected content checks.
3. `website-check` installs pinned Bun, restores caches, performs a frozen install, and runs precommit.
4. `website-build` uploads `website/_site/` as a short-lived artifact without Bunny credentials.
5. `website-deploy` downloads that exact artifact. `main` goes to production; other branch pushes go to staging;
   pull requests never deploy.
6. `indexnow` submits changed production URLs after production succeeds.
7. `notify` reports failures without hiding the original error.

Use `website-production` and `website-staging` GitHub environments. Give the shared staging zone one concurrency
group and cancel superseded staging runs; never cancel an active production deployment. Pin third-party actions
to reviewed SHAs, declare minimal permissions and explicit secrets, and remove `secrets: inherit`.

Use GitHub variables for public build values where practical: FormSpark ID, Botpoison public key, and public
IndexNow verification key. Bunny credentials, Apify token, and notification credentials remain secrets.

Recreate `BUNNY_ACCESS_KEY`, production/staging storage settings, pull zone IDs, `INDEXNOW_KEY`, `FORMSPARK_ID`,
`BOTPOISON_PUBLIC_KEY`, `NTFY_TOPIC`, and `APIFY_API_TOKEN` in this repository.

### Review updater

Keep Monday 09:00 UTC and manual triggers, using `website/` as working directory. Before enabling it:

1. Add and validate the Google place ID.
2. Make `website/reviews/` visible on the review page, or delete the unused importer rather than keep dead output.
3. Test escaping, formatting, duplicate detection, and an empty provider response.
4. Open or update a PR containing only review records instead of pushing to protected `main`.
5. Use a GitHub App token able to trigger normal PR checks; workflow `GITHUB_TOKEN` pushes do not reliably do so.

## Executable product specifications

The Cucumber architecture, spike evidence, first replacement, coverage/mutation integration, and acceptance
criteria are specified in `CUCUMBER_MVP.md`.

The essential model is:

- A Feature is one user story or capability.
- A Rule is one canonical observable product fact.
- A Scenario is one concrete example that proves the Rule.
- A Scenario Outline is a schema-shaped family of examples.
- Stable `@story:`, `@rule:`, and `@case:` tags supply durable identity; actor, edition, owner, risk, and surface
  tags have closed validated values.
- The official Gherkin AST and Pickles supply authored and executable schemas.
- Cucumber Messages NDJSON supplies the generated catalog and execution evidence.
- The official Cucumber programmatic API runs inside the existing Deno test harness with typed World and hooks.
- Direct coverage and mutation remain the proof of internal behavior. Acceptance stories do not excuse a missing
  mirrored direct test.

The first story covers a paid booking that loses the last place. Its three Scenarios replace existing successful
confirmation, sold-out/refund, and replay integration cases. The old and new cases may coexist while being
developed, but the merged change deletes the old path.

## Website semantics

Website pages name the story IDs they discuss in schema-validated front matter. Use Rule IDs at block level only
when one page covers unrelated claims. This replaces behavior-fact JSON and separate behavior usage sidecars.

The content checker receives selected Feature descriptions, Rules, Scenarios, scope tags, and website text. For
each Rule it returns `supported`, `not_present`, `contradicted`, `overstated`, or `wrong_scope`, and reports
unsupported objective claims.

Use one provider directly, pin model/prompt/output schema, require strict Valibot JSON and verbatim source quotes,
derive pass/fail locally, cache by all semantic inputs, retry transport failures only, bound input/concurrency,
and keep LLM keys out of `pull_request_target`. Output stable annotations and inspectable JSON artifacts.

Passing Pickles, direct coverage, and mutation replace the proposed fact-to-test LLM checker. The LLM judges
promotional prose only; it does not decide whether application behavior works.

## Delivery

### Phase 1: import and parity

Import history, align Bun/template pins, fix paths/Nix/CMS/instructions/tests, and compare sitemap, links, dates,
and assets with production. Do not switch deployment until website precommit is green and public output matches.

### Phase 2: isolated automation

Add path-aware required checks, artifact deployment, environments, secrets, caching, concurrency, IndexNow,
notifications, app workflow exclusions, and the repaired review updater.

Exit: website-only changes deploy staging or production once; app-only changes never start a website build.

### Phase 3: Cucumber MVP

Implement `CUCUMBER_MVP.md`: pin the official runner, validate the authored profile, reuse the Deno harness, add
typed World/hooks/reports, replace the three payment-capacity integration cases, and pass direct coverage and
targeted mutation.

Exit: the first Feature is the only narrative path for those behaviors and standard Messages provide its catalog.

### Phase 4: website semantics

Map the overbooking page to the first story and run advisory semantic checks. Then register home, pricing,
hosting, FAQ, backups, encryption, EU hosting, payments, and email content against the relevant stories/Rules.

Exit: changed objective behavior copy cannot merge without supporting Rules, and full audit reports no uncovered
behavior-claim area.

### Phase 5: story migration

Migrate narrative tests only when each change deletes its old orchestration and reuses shared domain vocabulary.
Prioritize no-quantity tickets, ticket editing, servicing, booking, accounting, and live payment-provider journeys.

Exit: Cucumber owns user journeys; direct Deno tests own mechanisms, exhaustive cases, and technical invariants.

## Acceptance criteria

- `website/` contains the complete tracked site and useful history; the old repository can be archived with a
  pointer to `tickets/tree/main/website`.
- Local and CI website builds use the same Bun and template revisions.
- Every `website/**` change builds the website. No other change does, except workflow edits or manual runs.
- App-only changes never deploy the website; website-only changes never build/deploy the app or app docs.
- The required `test` status exists for every PR and merge group.
- Pull requests receive no deployment secrets; production deploys the exact artifact that passed checks.
- Bunny production/staging, IndexNow, notification, and review updates remain functional with pinned actions and
  explicit permissions.
- Spec-only changes validate and run affected stories/content without building or deploying the website.
- Cucumber runs under Deno in the existing harness and replaces, rather than duplicates, selected narrative tests.
- Gherkin AST, Pickles, and Messages provide the structured story catalog; generated catalogs are not committed.
- LLM output is schema-validated, cached, inspectable, and never the sole proof of application behavior.
- `nix develop -c deno task precommit` passes after each implementation phase.
