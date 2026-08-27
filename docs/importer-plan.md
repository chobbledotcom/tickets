# CSV Importer Plan

## Goal

Build an admin-only CSV importer: a **generic, schema-driven engine** that turns
third-party CSV exports into bookings in this system. The first (and, for now,
only) schema is **`event_bookings`** — the `bookings.csv`-style export this plan
describes in detail. The operator picks a schema from a list when uploading, and
**more schemas will be added later**, so the engine stays generic and every
`event_bookings` specific lives in a schema definition, not in the engine.

The importer is idempotent and all-or-nothing:

- A CSV upload either creates every unimported booking it can create, or creates
  none of them.
- Source bookings already recorded in the import map are skipped.
- The importer never creates products/listings, attendee statuses, or custom
  questions — it only **matches** imported names to existing records, and sends
  the operator to fix any setup that's missing.
- **Everything checkable is checked before any write, and every problem is
  reported at once.** A clean preflight is the precondition for the write; the
  operator fixes setup/data in one pass and re-uploads rather than hitting
  errors one at a time. See
  [Architecture & Core Principles](#architecture--core-principles) and
  [Preflight & Error Reporting](#preflight--error-reporting).
- Legacy imports may overbook. Capacity warnings can be reported, but capacity
  does not block the import.

## Architecture & Core Principles

The importer is a **generic engine** parameterised by a **schema definition**,
around four rules that the rest of this plan must satisfy:

1. **Schema-driven and generic.** The engine knows nothing about any particular
   CSV. A `SchemaDefinition` (e.g. `event_bookings`) supplies the column
   mapping, required columns, product/status/question resolution config, and
   per-field parsers/validators. Adding a future format means adding a schema,
   not editing the engine. The operator selects the schema on upload — see
   [Schemas](#schemas).

2. **Pure, functional core; thin effectful shell.** The pipeline is
   `parse → load context → resolve + validate (preflight) → plan → write`. Every
   stage except the first (file read) and last (the write transaction) is a
   **pure function** of its inputs: parsing, resolution, validation, and
   planning take the parsed rows plus a snapshot of existing DB context
   (listings, statuses, questions, prior imports) and **return data — no DB
   writes, no hidden I/O**. That is what makes the importer testable and the
   schema config swappable. Only the final writer touches the database, in one
   guarded transaction.

3. **Exhaustive preflight.** Do everything possible so the write transaction
   cannot fail on anything we could have detected first: resolve all names,
   validate every field, check idempotency, classify every row, and confirm
   representability before any write. "Validate at write time and let the
   transaction abort" is a last resort for genuinely unexpected/infrastructural
   failure, not the design — and even then the whole file rolls back.

4. **Report every problem at once.** Preflight does **not** fail fast. It
   accumulates _all_ problems across the whole file — missing setup, ambiguous
   matches, source-data errors, non-creatable rows, unrepresentable bookings,
   invalid fields — and returns them together, grouped by kind, each with the
   exact fix and a link where one exists. The operator fixes everything in one
   pass and re-uploads. A single comprehensive error report, never a
   stop-at-first-error trickle. See
   [Preflight & Error Reporting](#preflight--error-reporting).

5. **House style (AGENTS.md — "Designing New Systems").** The implementation
   follows the repo's standards, not a parallel idiom: the `SchemaDefinition` is
   a **valibot**-modelled typed schema (types/guards/options derived from one
   declaration, exhaustive `Record` dispatch — never branch-per-case chains);
   admin pages/forms/tables go through the existing `define*` factories and the
   entity-pages framework (see the routes section — no hand-rolled dispatchers
   or bespoke CRUD); the engine arrives as a small directory of single-purpose,
   **under-~400-line** files with the pure core split from the IO shell, using
   `#fp` helpers; and it lands with 100% deterministic test coverage, 0% jscpd
   duplication, and tests that survive the precommit **mutation gate** (changed
   `src/` files are mutation-tested against all of their direct tests at a 100%
   kill rate).

## Schemas

A **schema** describes one CSV format. The operator chooses one when uploading;
the engine runs the same pipeline for all of them.

- **Registry.** A small registry maps a schema id (e.g. `"event_bookings"`) to
  its `SchemaDefinition` and a human label. `GET /admin/imports` lists the
  registered schemas; the operator picks one and uploads against it. New formats
  register a new definition — no engine changes.
- **What a `SchemaDefinition` provides** (all pure data/config the generic
  engine consumes):
  - `id` and `label`.
  - Required core columns and how to detect/validate them.
  - The field mapping (source columns → attendee/booking fields), with per-field
    parsers (dates, money, phone, email) and validators.
  - Product extraction + resolution config (how to read product names from a
    row, the separators, daily-only gating).
  - Status, free-text-question, and audit-column config (required vs
    optional/audit-only; which columns are internal/staff-only).
  - The idempotency key (which column is the stable source id).
- **`event_bookings` is the first schema.** Everything below from
  [Current CSV Shape](#current-csv-shape) onward — the column shape, product
  extraction, booking/field mapping, financial and status mapping, custom
  questions, legacy-metadata routing — **is the `event_bookings` definition**,
  not engine behaviour. Read "the importer does X" as "the engine, configured by
  `event_bookings`, does X"; another schema could configure it differently.
- **Genericity guardrail.** No `event_bookings` column name, separator, or quirk
  may be hard-coded in the engine, parser, planner, or writer — they read it
  from the active `SchemaDefinition`. Add a test that the engine carries no
  schema literals (or that a trivial second schema runs end-to-end), so the
  second real format doesn't require an engine rewrite.

## Landed Dependencies (read first)

The importer builds on several systems that were in-progress branches when this
plan was first written and have **since merged into main**:

- **Free-text custom questions** (PR #1335 — "Add free-text custom questions
  with encrypted string storage and answer plumbing") is **in main**. The
  importer builds directly on its schema and helpers and **must not**
  reintroduce any of them; the "Custom Questions" story below uses its concrete,
  shipped API. See
  [Free-Text Questions Dependency](#free-text-questions-dependency).
- **The immutable double-entry `transfers` ledger** (main's accounting work) is
  **in main** — a listing's income, an attendee's owed balance, a booking's
  amount-paid, and a modifier's revenue all project from it, and the importer
  records money by posting to it. See [Financial Mapping](#financial-mapping).
- **The no-quantity (`quantity = 0`) sentinel** shipped as **PR #1366** ("Add
  no-quantity booking lines"): the shared `TICKET_COUNTS_PREDICATE`, the owner
  "no quantity" checkbox + save-path guards, and the
  operational/public/marketing exclusions all exist. The importer is a
  **consumer** of it (it writes `quantity = 0` lines); only the
  _importer-specific_ additions remain to build (see Phase 6). The feature's
  surface-by-surface behaviour is locked in by its own test suite
  (`test/integration/no-quantity-audit.test.ts`, the
  `attendees.no-quantity-tickets` story, and the shared-predicate guard tests).
  One shipped gap matters here: the **merge writer has no whole-result owed-leg
  reversal** (the edit path reconciles a no-real-lines attendee's owed balance
  to £0 with a `writeoff` leg; the merge does not) — see the merge notes below.
- **Contact/attendee notes rework** landed as a per-attendee **`system_notes`**
  table (owner-public-key-encrypted `owner` notes + DB-key `system` notes) plus
  per-contact `/admin/history/:hmac` records. The original plan's single
  per-attendee `notes` column no longer applies; the importer's raw audit trail
  lands in `system_notes` **owner** notes (`createOwnerNote`, owner-public-key —
  no unwrapped private key needed to write). See
  [Where Legacy Metadata Goes](#where-legacy-metadata-goes).

## Free-Text Questions Dependency

The free-text custom questions feature (PR #1335, **now in main**) is the
mechanism the importer uses for every legacy free-text column (`Surface`,
`Age Group`, the party questions, exhibition stand number, etc.). The plan
previously hedged this as "once the custom question system supports text
answers" — that system now exists, so the hedging is replaced with the real,
shipped contract.

What #1335 provides, and the importer reuses verbatim:

- **`display_type` gains `"free_text"`.** `QUESTION_DISPLAY_TYPES` is now
  `["radio", "select", "free_text"]`. A free-text question has **no answer
  rows** — `withAnswers` was changed to keep `free_text` questions even though
  their `answers` array is empty. So a free-text question is identified purely
  by `display_type === "free_text"` and its decrypted `text`.
- **`strings` table** — a deduplicated, owner-key-encrypted text repository:
  `(id, text_index TEXT UNIQUE, encrypted_text, used_count, created)`.
  - `text_index = hmacHash(text)` (deterministic HMAC; the unique index is what
    makes dedup work).
  - `encrypted_text = encryptWithOwnerKey(text, settings.publicKey)` — hybrid
    encryption against the **owner public key**, _not_ the symmetric
    `DB_ENCRYPTION_KEY`.
  - `used_count` is trigger-maintained from `attendee_answers`; the delete
    trigger only **decrements** it (it does not remove the row). Unused rows are
    reaped by an **age-based pruner** — `pruneUnusedStrings` deletes where
    `used_count = 0 AND created < cutoff` — and `getOrCreateStringIds` refreshes
    `created` on every row it references, so a reused string's prune clock
    resets.
- **`attendee_answers` shape change.** `answer_id` is now nullable; new
  `question_id` (now required on **every** row) and `string_id` columns. BEFORE
  triggers enforce a strict XOR per row:
  - choice answer: `answer_id` set, `question_id` set, `string_id` NULL;
  - text answer: `answer_id` NULL, `question_id` set, `string_id` set. A new
    unique index `(attendee_id, question_id)` means **at most one free-text
    answer per question per attendee**.
- **Helpers** (all under `src/shared/db/questions/`):
  - `getOrCreateStringIds(texts: string[]): Promise<Map<string, number>>` —
    dedupes, encrypts each unique text with the owner public key,
    `INSERT OR
    IGNORE`s into `strings`, and returns a `text → stringId` map.
  - `saveAttendeeAnswers(Map<number, number[] | AttendeeAnswerSet>)` where
    `AttendeeAnswerSet = { answerIds: number[]; textAnswerIds?: TextAnswerId[];
    textAnswers?: TextAnswer[] }`,
    `TextAnswer = { questionId; text }`,
    `TextAnswerId = { questionId; stringId }`. Passing `textAnswers` lets the
    caller hand over raw source text and have the string created/looked-up for
    it.
  - `getAttendeeTextAnswers(attendeeId, privateKey): Promise<Map<number, string>>`
    — reads answers back, decrypting with the owner **private** key.

Two consequences that drive importer design:

1. **Writing free-text answers needs only the owner public key** (via
   `settings.publicKey`), exactly like the public checkout path. The importer is
   admin-authenticated, but it does not need the unwrapped private key to
   _write_ imported answers. Reading them back (e.g. in tests, or the attendee
   edit form) does need the private key.
2. **`getOrCreateStringIds` takes an optional `TxScope`**, so the string rows
   can be interned on an open transaction rather than in a batch of their own.
   `saveAttendeeAnswers` already runs its delete, interning, and insert inside
   one `withTransaction`. The importer's whole-file transaction threads the same
   handle — see [All-Or-Nothing Write Strategy](#all-or-nothing-write-strategy).

## Current CSV Shape

These numbers come from a real `bookings.csv` export observed **out of repo**.
The file is **not** committed and must not be — it is a live customer export
full of PII. Treat the figures below as observations from that external sample,
and build a small **synthetic/anonymised** fixture (a handful of rows
reproducing the awkward shapes: BOM, duplicate `Date` columns, slash-in-name
products, empty `Equipments` with a `Quoted for Products` block) for the tests.
If you have the real export locally, keep it outside the working tree (e.g. a
gitignored path) when validating the parser against it.

Observed from that sample export:

- 226 booking rows.
- 628 columns.
- The first 50 columns are core booking/customer fields.
- There is one blank header column at index 19, apparently a delivery/location
  name field.
- 267 `Modifier: ...` columns and 22 `Payment: ...` columns, each followed by a
  repeated `Date` column. Do not parse this file into a simple
  `Record<header, value>` because duplicate `Date` headers will be lost.
- 186 rows have `Equipments` populated.
- 32 rows have empty `Equipments` but `Operator Notes` contains a
  `Quoted for Products:` block.
- Status values in `Status` include `Quote`, `Confirmed`, `Pending`,
  `Event Payment Received`, `PO Received`, `Event invoice sent`, `Cancelled`,
  and `Paid Cash`.
- `Colour Name` also carries workflow labels such as `Cancelled`, `Confirmed`,
  `Quotes`, `Paid in Full`, `White`, and `Event Invoice Sent`.
- Custom text/question columns present before the modifier columns:
  - `Is your party for a boy or girl?`
  - `Do you require Extra Extra Coconuts?`
  - `Do you require us to supply the toys?`
  - `Do you Require Supervision?`
  - `Exhibition: Please supply stand / hall number ...`

## Data Model

Add one table for import idempotency:

```ts
[
  "booking_imports",
  {
    columns: [
      ["schema", "TEXT NOT NULL"],
      ["old_id", "TEXT NOT NULL"],
      ["new_id", "INTEGER NOT NULL"],
    ],
    indexes: [
      {
        name: "idx_booking_imports_schema_old",
        columns: ["schema", "old_id"],
        unique: true,
      },
      {
        name: "idx_booking_imports_new_id",
        columns: ["new_id"],
        unique: false,
      },
    ],
  },
];
```

- **`schema`** namespaces the source id (e.g. `"event_bookings"`). The importer
  is schema-driven and future formats will reuse ordinary source ids, so a bare
  `old_id` would collide across schemas (`event_bookings` booking `42` vs
  another schema's order `42`) and wrongly skip the second as already-imported.
  The **idempotency key is the composite `(schema, old_id)`** (the unique
  index), and every idempotency lookup/skip is scoped by the active schema.
- `old_id` is the stable source id _within a schema_ (for `event_bookings`, the
  `Booking ID`). A re-upload of the same schema skips any `(schema, old_id)`
  already in the map.
- `new_id` is the created `attendees.id`. The index on it is **not unique**:
  after an attendee merge, several source ids can legitimately point at one
  surviving attendee, so a unique `new_id` would wrongly forbid that — and force
  deleting a mapping, which would let a re-upload recreate a duplicate booking.
  Uniqueness lives on `(schema, old_id)`, which is all idempotency needs.
- No separate import-run table for the first pass. The user asked for only old
  id and new id (plus the `schema` namespace), and idempotency does not require
  run metadata.
- Add the table to the declarative schema and a migration. Keep the schema
  update narrow and follow the existing migration pattern.

The importer does **not** add the `strings` table or the `attendee_answers`
`question_id`/`string_id` columns — those arrive with PR #1335's migration
`2026-06-20_free_text_questions`. Besides `booking_imports`, the importer adds
one more table: a **short-lived missing-setup stash** (token PK, uploader
`user_id` — the admin-binding column the report GETs enforce, see Proposed
Routes And UI — **encrypted** payload, created/expires) so the POST→`/missing`
redirect survives Bunny's cross-isolate runtime (see Proposed Routes And UI).
Encrypt the payload at rest: it holds the missing product / status / question
names and internal column headers (potential PII-field labels), which are
encrypted everywhere else, so a failed first upload must not leave them in
plaintext until TTL cleanup. Both go in the importer's migration, sequenced
after the free-text one.

Ledger interaction (merged from main). Money is now an immutable double-entry
ledger; the importer **reads from and writes to it**, it does not own it:

- The **`transfers`** table already exists (main's accounting work). The
  importer posts to it (see [Financial Mapping](#financial-mapping)); it does
  **not** add or alter the table.
- It adds **one new account**, `imported:default`, to the chart of accounts
  (`shared/accounting/accounts.ts`) — a contra/clearing counterparty so imported
  money never lands on `revenue` (listing income) or `external:world` (real
  cash).
- `listing_attendees.ledger_event_group` already exists (main); the importer
  **stamps** it on each line with the booking's ledger event group.
- The dropped columns `listing_attendees.price_paid`, `attendees.price_paid`,
  `attendees.remaining_balance`, and `modifiers.total_revenue` are **gone** —
  the importer must not reference them anywhere (income/balance/amount-paid
  project from the ledger).

Attendee notes / legacy metadata storage:

- The original plan added a per-attendee encrypted `notes` column as the single
  home for `Customer Notes`, `Operator Notes`, payment metadata, etc. The notes
  rework has since **landed**: main added a **`system_notes`** table, whose rows
  name the kind of record they are about and which one
  (`src/shared/db/notes/queries.ts`) — owner-public-key-encrypted `owner` notes
  (`createOwnerNote`) plus DB-key `system` notes — alongside per-contact
  `/admin/history/:hmac` records. **Do not** add a competing per-attendee
  `notes` column; `system_notes` is the home.
- Net effect on this plan: lean on **free-text questions** for the legacy text
  we actually want surfaced and searchable per booking (see
  [Custom Questions](#custom-questions)), and write the raw audit-trail dump to
  a per-attendee `system_notes` **owner** note. Keep `special_instructions` for
  customer-facing booking instructions.
- A durable encrypted home for the raw audit trail is a **prerequisite for the
  writer** — and it now exists: `system_notes` **owner** notes are encrypted
  with the **owner public key** (`createOwnerNote`), so the keyless import write
  path can persist them with no unwrapped private key, exactly like the
  free-text string writes. The writer must still fold the note inserts into its
  own guarded transaction — **`createOwnerNote` cannot be called at all here**:
  it inserts via the global `execute` path with no transaction parameter, so a
  note written through it would survive the import's rollback as an orphaned
  encrypted record. Encrypt the note text with the owner public key up front
  (outside the write lock), then execute the `system_notes` INSERT statements
  **inside the importer's transaction** (a tx-scoped variant of the helper,
  mirroring `postTransfersTx`). The writer must also **block** any import
  carrying unmapped audit fields rather than dropping them — never import with
  data loss. The destination is **decided** (`system_notes` owner notes); see
  [Where Legacy Metadata Goes](#where-legacy-metadata-goes).

## Proposed Routes And UI

Add admin routes (**schema-scoped**, so future formats reuse them unchanged):

- `GET /admin/imports`
  - Lists the registered schemas (see [Schemas](#schemas)); the operator picks
    one to upload against.
- `GET /admin/imports/:schema` (e.g. `/admin/imports/event_bookings`)
  - Upload form for the chosen schema, with short instructions and links to
    existing listings/questions.
- `POST /admin/imports/:schema`
  - Authenticated multipart upload. **Enforce resource limits before buffering**
    (this route deliberately accepts very wide legacy CSVs, and Bunny isolates
    have tight memory/CPU budgets): cap the request size before reading the
    body, and cap rows, columns, cell size, parse duration, and accumulated
    report size — exceeding any cap rejects the upload with a clear error rather
    than exhausting the isolate mid-preflight (limits generous enough for the
    real exports, e.g. the 628-column/226-row sample, with headroom). Then
    parses, runs the **pure preflight** (resolve + validate + plan, no writes),
    and runs the write transaction **only if there are no blocking errors**.
    Redirects to the preflight error report on blocking errors; otherwise to the
    **success report** (`GET .../success?stash=<token>`, defined below) —
    stashing the report (created count _plus the skipped/non-creatable rows with
    their row details_, not just counts) so the redirect shows the operator
    exactly what was skipped, nothing silently dropped.
- `GET /admin/imports/:schema/errors?stash=<token>` — the **preflight error
  report**: the single "here's everything to fix" page. Missing setup is one
  section of it; see [Preflight & Error Reporting](#preflight--error-reporting).
  - Populated from a **short-lived, durable stash**, addressed by
    `?stash=<token>` — **not** repeated `product` / `status` / `question`
    params, which the first upload of a wide CSV can push past Location/header
    limits and strand the operator. The POST writes the report to the stash and
    redirects with the token; this GET reads it back. **Bind each stash to the
    initiating admin:** the stash row records the uploader's user id and the GET
    returns the report only to that admin (the token alone is a bearer secret
    that can leak via browser history, proxy logs, or referrers — and the report
    holds row identifiers, headers, and offending values). Serve both report
    pages with `Cache-Control: no-store` and strict referrer handling, and
    prefer truncated/redacted offending values where the full value isn't needed
    to fix the row. **Store the stash in libsql with a TTL** (a small table +
    cleanup pass), **not process-local memory:** production runs on Bunny Edge
    Scripting, where the POST and the redirected GET can hit different isolates,
    so an in-memory stash would often read back empty (the codebase already
    handles cross-isolate staleness elsewhere). A signed/encrypted
    self-contained token is a fallback only for _small_ reports — a large one
    would re-hit the URL limit.
  - Renders one link per missing product (`/admin/listing/new?import_name=Foo`),
    each missing status (link to `/admin/settings/statuses/new`), and each
    missing free-text question (link to `/admin/questions`, told to create a
    **free-text** question with the exact text; prefill via
    `?import_text=Surface` if cheap). It also renders the non-setup problems —
    ambiguous matches, source-data errors, non-creatable and unrepresentable
    rows — see the report section.
- `GET /admin/imports/:schema/success?stash=<token>` — the **success report** a
  completed import redirects to. Reads the same kind of durable, TTL'd libsql
  stash as the error report (written by the POST, addressed by `?stash=<token>`
  — **not** process-local memory, for the same cross-isolate reason), and shows
  the created count plus every skipped / already-imported / non-creatable row
  with its details. A missing/expired stash renders a minimal "import complete"
  fallback rather than a 404. (Both reports share one small stash table +
  cleanup pass.)

Extend listing creation:

- `GET /admin/listing/new?import_name=...`
  - Pre-fill the listing name.
  - Render the name as readonly.
  - Keep all normal listing fields available, because the importer cannot infer
    capacity, pricing, images, groups, etc. The importer **is** daily-only,
    though, so prompt the operator to create the listing as a **daily** listing
    (a standard-type listing will be rejected at import — see Product matching).
- `POST /admin/listing?import_name=...`
  - Treat `import_name` as the source of truth for `name`, not the submitted
    form value.
  - The readonly HTML is for the user experience; the server must still enforce
    the locked name.

**Integration with landed admin infrastructure:**

- **Respect read-only mode.** Main added a site read-only mode (#1454) that
  default-denies mutating methods; the importer's `POST /admin/imports/:schema`
  and the `POST /admin/listing` create must honour it like every other admin
  write, so a bulk import can't run while the site is frozen.
- **Reuse the `catalog-transfer` resolver + `entity-pages` framework — don't
  reinvent them.** Main's merged `catalog-transfer` importer
  (`src/features/admin/catalog-transfer/`) already does name-based, id-free
  reference resolution with duplicate/ambiguity detection and per-field issue
  reporting (`formatTransferIssues`) — the same shape this plan's
  product/status/question resolver and error report need. It imports _catalog
  structure_ (listings/groups/pricing), **not** bookings, so it does not
  supersede this importer, but the resolver/report should mirror its patterns
  and the admin pages should use the `entity-pages`/`define*` factories rather
  than hand-rolled routes. (The `docs/external-order-library.md` spec (#1443) is
  unrelated — an outbound, client-side add-to-cart widget that writes nothing
  server-side.)

**Persist the missing-setup set server-side from the first implementation** — a
short-lived stash keyed by a token in the redirect URL — rather than packing
every missing item into repeated query params. The worst case is not "later, in
real uploads": it is the **first** upload of a wide legacy CSV before any setup
exists (the sample has 628 columns), which can produce a large missing-question
list. If that Location header is rejected or truncated by a proxy/browser, the
operator never reaches the setup page and can't import at all. Query params are
fine as a fallback for small lists, but don't make reaching the setup page
depend on URL length.

## Preflight & Error Reporting

Preflight is the pure core (principles 2–4): given the parsed rows and a
snapshot of existing context, it resolves everything, validates everything,
classifies every row, and returns either a clean import plan **or** a complete
problem report — without touching the database.

**Accumulate, never fail fast.** Every check appends to the report and keeps
going, so one upload surfaces _all_ problems at once. The report has **two
tiers**, and the write decision keys off the first:

**Blocking errors — no write happens until every one is fixed:**

- **Missing setup** — products/statuses/required questions with no local match,
  plus products matching a `standard`-type listing that must be made daily. Each
  with a fix link (see [Missing Setup](#missing-setup-error-page)).
- **Ambiguous setup** — a name matching more than one local listing / status /
  free-text question (names aren't unique and are encrypted). Operator
  disambiguates; the engine never guesses.
- **Source-data errors** — duplicate `Booking ID`s within the file, conflicting
  duplicate columns mapping to one question with different values, invalid or
  unparseable **required-value** fields — each keyed to the offending row.
- **Unrepresentable bookings** — e.g. the same listing on two **non-identical**
  date ranges, which one `(attendee, listing)` line can't hold (see
  [Quantity](#booking-mapping)).

**Skips & warnings — reported, but the valid rows still import:**

- **Already-imported** rows (their `(schema, old_id)` is in the map) — skipped.
- **Non-creatable** rows — zero products, so no line could be written — skipped.
- Informational warnings (e.g. a residual `Balance` on a non-reservation status
  — posted faithfully to the ledger for the admin record, just never publicly
  payable; see [Financial Mapping](#financial-mapping)).

These are **not** things to fix; blocking the whole upload over one blank or
already-imported row would be wrong. They're listed (on the success page and in
the report) so nothing is silently dropped.

Every entry names the offending row(s)/column(s) and the exact fix. Row-level
**errors** don't abort the run — they're collected with the rest — but they do
gate the write. The operator fixes the whole report and re-uploads; idempotency
means the already-creatable rows aren't duplicated. Only genuinely
unexpected/infrastructural failure is left to the write transaction, which still
rolls the whole file back. (The same report object is what the POST stashes and
the `…/errors` page renders.)

## Parsing Plan

Create a real CSV parser or add parse support beside `src/shared/csv/index.ts`.
The current CSV helper only generates CSV.

Parser requirements:

- Strip a UTF-8 BOM from the first header.
- Preserve column order and duplicate headers.
- Correctly handle quoted commas, quotes, CRLF, and newlines.
- Return rows as arrays plus a header array, not as a single object keyed by
  header.
- Validate that required core columns are present at the expected names.

Required columns for MVP (these are required _headers_ — the column must be
present at the expected name; per-**value** requirements are separate, and some
values are optional, e.g. `Date Booked` falls back to import time — see Booking
Mapping):

- `Booking ID`
- `Status`
- `Date Booked`
- `Delivery Date`
- `Drop Off`
- `Collection Date`
- `Collection`
- `Customer Name`
- `Telephone`
- `Mobile`
- `Email`
- contact address columns
- delivery address columns
- `Equipments`
- `Total`
- `Received`
- `Balance`
- `Customer Notes`
- `Operator Notes`
- `Colour Name`

## Product Extraction

Resolve product names for each unimported source booking before any writes.

Extraction order:

1. Use `Equipments` as authoritative when it is populated. These are
   actually-booked products and become real lines (`quantity >= 1`) — **unless
   the row's source `Status` is a non-capacity status, in which case every
   matched line is `quantity = 0` regardless of `Equipments`** (see Status
   Mapping). The `SchemaDefinition` declares which **source** status values are
   non-capacity — for `event_bookings` that is `Cancelled` **and `Quote`**: a
   quote-status row with a populated `Equipments` field was quoted for those
   items, not booked, and capacity is status-blind, so importing it as real
   lines would consume calendar capacity (and post money legs) for an
   unconfirmed booking. Apply the status verdict after extraction so such a row
   never consumes capacity or leaks into public/operational surfaces, even with
   a populated `Equipments` field.
2. If `Equipments` is empty, parse `Operator Notes` blocks of the form
   `Quoted for Products: -- Product A -- Product B -- Products (xN) ...` as a
   fallback and report that fallback in the import summary. These are
   **interested-in / quoted** products, not confirmed bookings, so they are
   matched to real listing names exactly like `Equipments` but stored as
   **zero-quantity lines** (see
   [Zero-Quantity Booking Lines](#zero-quantity-no-quantity-booking-lines)).
   Unmatched names here are still _missing products_ (→ missing-setup page), the
   same as unmatched `Equipments` names.
3. Never use `Operator Notes`, modifier columns, or payment columns to add extra
   required products when `Equipments` is populated. Preserve those fields as
   free-text answers / notes instead.
4. Dedupe product names within a booking and convert duplicates to quantity only
   when we are confident they are repeated whole products. (Count-summing
   affects **active** `Equipments` lines only — a cancelled row's or quoted
   block's duplicates still collapse to a single line that is **written at
   `quantity = 0`**; dedupe must never resurrect capacity on a ghost line.)
5. A row with **no products at all** — empty `Equipments` _and_ no parseable
   `Quoted for Products` block — cannot become a booking (every source booking
   creates at least one `listing_attendees` line, even if quantity-0). Treat
   such rows as a defined, **reported non-creatable category**, removed from the
   candidate set before any writes (like already-imported rows), so the importer
   never creates an attendee/import-map row with no booking lines and never
   discovers the problem only mid-transaction. This is distinct from: (a)
   unmatched product _names_ in `Equipments` or the quoted block — those are
   _missing products_ fixable via the missing-setup page; and (b) a quote row
   _with_ a parseable `Quoted for Products` block — that is creatable, as
   quantity-0 interested lines. (A no-products row is a **non-blocking skip** —
   reported, not written, and it must **not** block the otherwise-valid
   bookings; the earlier "hard validation error" option is dropped, since it
   would redirect a whole upload over one blank row. The requirement is only
   that it's caught before writes, not left to fail the transaction.)

Important caveat: the export uses `/` as a product separator, but some product
names appear to contain slashes, for example names like
`Rodeo Bull / Bucking Bronco`. A naive split will create false missing products.

Product matching:

- Normalize for matching by trimming and collapsing whitespace.
- Start with case-insensitive exact matching after normalization.
- **Duplicate local listing names are an ambiguous-setup error, like duplicate
  statuses/questions.** Listing names aren't unique in the schema (and are
  encrypted), so a token can match **two** local listings — most likely after
  the standard→daily repair path leaves the old standard listing alongside the
  new daily one. A normalized-name map would silently pick/overwrite one
  (importing to the wrong listing, or still blocking on the old standard). When
  a product token matches more than one listing, block the upload and tell the
  operator to disambiguate — never guess.
- Match known listing names longest first over the raw `Equipments` text before
  splitting on separators. This lets a local listing named
  `Rodeo Bull / Bucking Bronco` win before the slash is considered a separator.
  **But if the split tokens are _also_ each a viable local match (e.g. both
  `Rodeo Bull` and `Bucking Bronco` exist as listings), the token is genuinely
  ambiguous — fail validation with a row-level error rather than silently
  preferring the combined listing**, since `/` is the source export's own
  product separator and either reading is plausible.
- **Only accept a match that spans a whole source product token** — i.e. the
  match must be bounded on both sides by a known separator or by the start/end
  of the field. A listing name that is merely a _substring_ of a token must not
  be consumed. Otherwise a local listing named `Bull` would eat part of the
  source product `Rodeo Bull / Bucking Bronco` and silently create a `Bull`
  booking, when the correct behaviour is to report the full source product as
  missing. Split the field into tokens on the known separators first (respecting
  the longest-known-name exception for names that legitimately contain a
  separator), then match each whole token.
- After consuming whole-token matches, report any remaining unmatched tokens as
  missing products.
- Preserve the original source spelling in missing-product errors.
- Do not silently fuzzy-match. If there is ambiguity, fail validation and show a
  row-level error.
- Do not add an alias mechanism. If source and local names differ, the operator
  must set up listings with matching names or fix the CSV before importing.
- **Every matched listing must be `daily`-type.** A product that matches a
  `standard`-type listing is a **blocking setup error** (listed on the
  missing-setup page), not an import. Verify the type at resolution, before any
  writes.
- **Fixed-duration daily listings must match the source span.** A daily listing
  with `customisable_days = false` treats its `duration_days` as fixed: the
  admin create path books that duration, and a later listing-edit save runs
  `recomputeListingBookingRanges`, which **rewrites every dated row's `end_at`**
  from the listing's `duration_days`. So importing a legacy multi-day hire onto
  a 1-day fixed daily listing would silently truncate (or expand) it on the next
  listing edit. Preflight gate: for a fixed-duration listing, the source
  `Delivery`→`Collection` span must **equal** the listing's `duration_days`; a
  mismatch is a blocking setup error telling the operator to enable
  **customisable days** on the listing (or fix the listing/source) — never
  import a span the listing's fixed duration will later rewrite. Whether the
  standard listing can be made daily depends on its data and its group: an
  _empty, ungrouped_ standard listing can be converted in place, but conversion
  is **unsafe** when (a) the listing **has existing bookings** — its undated
  rows would drop off the daily calendar/capacity, which only consider dated
  rows; or (b) the listing is in a **group with any other listings** —
  `validateGroupListingType` forces every listing in a group to share
  `listing_type` _regardless of whether the siblings are populated_, so the
  operator can't convert just this one in place (they must first remove it from
  **every** group whose members force the incompatible type — listings now have
  multi-group membership); and if the siblings are populated standard listings,
  converting the whole group would push their undated rows into the same hole.
  Block both cases as unresolvable setup errors (the operator must migrate /
  ungroup / replace deliberately); never auto-convert. This gate is what lets
  the importer treat every imported booking as dated end-to-end — daily listings
  carry the delivery/collection range on the line's `start_at`/`end_at` (run
  sheets) and are day-calendar entities — **without** retrofitting line dates
  onto the standard-listing model (which dates by `listing.date`, not the line).
  See Dates below.

Because listing names are encrypted at rest, the resolver will probably need to
load and decrypt existing listing names through an application helper rather
than doing a SQL name lookup. Keep the query narrow if adding a dedicated
helper.

## Booking Mapping

One source booking should become one `attendees` row with one or more
`listing_attendees` rows.

Suggested field mapping:

| CSV field                          | Target                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Booking ID`                       | `booking_imports.old_id`                                                            | Required, unique per CSV.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| created attendee id                | `booking_imports.new_id`                                                            | Write only after attendee creation succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Date Booked`                      | attendee `created`                                                                  | Parse the source booking date into `attendees.created` so admin "newest" views and calendar/list/CSV exports order imports by when they were originally booked, not import time. A missing or unparseable `Date Booked` is **non-fatal** — fall back to import time, **not** a blocking source-data error (`Date Booked` is a required _column_, but its _value_ is optional). **Two id-ordered surfaces must also change** (they order by `a.id`, and imports get fresh ids despite old `created`): the dashboard `getNewestAttendeesRaw` (`ORDER BY a.id DESC`) and the `/admin/attendees` browser + CSV `getAttendeesPage` (`ORDER BY a.id ASC/DESC`, paginated). Switch both to order by `created` with `id` as the next key (`ORDER BY a.created DESC, a.id DESC`; ascending for the `oldest` variant), backed by a composite index on `(created, id)`. **`getAttendeesPage` JOINs `listing_attendees` and returns one row per booking line**, so a multi-listing import has several rows sharing `created`+`id`; add a stable booking-line tiebreaker after `a.id` for that query, ending in a **unique** key — `ea.listing_id`, `ea.start_at`, then `ea.id` (the line's own PK; needed because the unique slot includes `parent_listing_id`, so package/folded child rows can tie on `listing_id` + `start_at`) — so OFFSET pagination and CSV export are deterministic (apply the same key to `getNewestAttendeesRaw` if it also joins per line). |
| `Customer Name`                    | attendee `name`                                                                     | **A blank name is a blocking source-data error** (reported with row + column; the operator fills it in the CSV and re-uploads). The admin edit form requires `name` on every save, so importing blank would defer the failure to the first edit, and inventing a placeholder would violate "never guess".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Email`                            | attendee `email`                                                                    | Import the raw source value, including invalid or concatenated emails. Add importer-specific support so these rows do not get rejected or split. **Accepted tradeoff:** the edit form renders `email` as `type="email"` and POST runs `validateEmail`, so the first admin re-save of an imported row with an invalid/concatenated email is blocked until the operator fixes or clears it; the importer does not relax the edit path or relocate the raw value (decision: keep raw).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Mobile`, `Telephone`              | attendee `phone`                                                                    | Prefer mobile; append alternate phone to a free-text answer / notes if both exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| delivery address fields            | attendee `address`                                                                  | More useful for hire/logistics than contact address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| contact address fields             | free-text answer / notes                                                            | No second structured address field exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Customer Notes`, `Operator Notes` | free-text answers (preferred) and/or the per-attendee `system_notes` **owner** note | Booking-specific, so **not** the per-contact history note (two bookings sharing an email/phone would merge). See [Where Legacy Metadata Goes](#where-legacy-metadata-goes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Delivery Date`, `Collection Date` | booking `date`, `durationDays` (line `start_at`/`end_at`)                           | Every imported line is on a **daily** listing (gated at resolution — see Dates below), so it is naturally dated; this range drives run sheets and the day-calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Drop Off`, `Collection`           | `listing_attendees.start_time`, `end_time`                                          | Requires importer-specific write/update; current create helper does not accept these.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Total`, `Received`, `Balance`     | ledger transfers (attendee ↔ `imported`)                                            | Posted to the `transfers` ledger, **not** stored as columns (`price_paid`/`remaining_balance` are gone). Owed balance projects as `−balanceOf(attendee)`. See [Financial Mapping](#financial-mapping).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Status`                           | attendee `status_id`                                                                | Resolve source status by existing attendee status name. See status mapping below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Colour Name`                      | free-text answer / notes                                                            | Preserve as legacy metadata; do not use for status resolution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| custom question columns            | `attendee_answers` text answers                                                     | Match each header to an existing `free_text` question by normalized exact text; store the source value as a string answer. See [Custom Questions](#custom-questions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Dates — every imported booking is dated (daily listings only):

- **The importer only imports products that match `daily`-type listings** (gated
  at resolution — see Product matching), so every imported line is inherently
  dated. Store `date` from `Delivery Date` and `durationDays` as the day span
  through `Collection Date`; the daily listing's `start_at`/`end_at` then carry
  the delivery/collection range.
- This makes the **day-calendar** work out of the box, without touching the
  standard-listing model: it dates daily listings by the line's `start_at`
  (`getDailyListingAttendeesByDate`), which the import populates. **Run sheets
  are not automatic, though:** `getAgentRunSheet` filters on the row's
  `start_agent_id`/`end_agent_id` matching the querying agent, and the importer
  does **not** assign agents (the CSV carries delivery/collection _times_, not
  staff). So an imported line carries the right
  `start_at`/`end_at`/`start_time`/ `end_time` and appears on the day-calendar
  immediately, but reaches an agent's run sheet only once an admin assigns an
  agent. Accept that (the realistic choice) or add agent assignment to the
  importer — don't claim run sheets work out of the box.
- The daily-only gate is deliberate: standard-type listings date by
  `listing.date` (the calendar's `buildStandardListingDateMap` and the ICS
  feed's `DTSTART`), **not** the line, so retrofitting line dates onto them
  would force new line-date paths through the calendar, the feed, and the edit
  form. Gating to daily avoids that whole blast radius. (Replaces the earlier
  "date every line, including standard" approach.)
- Duration should be at least 1 day; same-day delivery/collection is 1 day. **A
  reversed range — `Collection Date` before `Delivery Date` — is a blocking
  source-data error, not a clamp.** Don't coerce a negative span to `1` (as
  `normalizeDurationDays` would): that silently imports the booking on the wrong
  dates, so the daily calendar/capacity and collection logistics no longer match
  the source. Report it for the operator to fix.

Quantity:

- If the same **active** (confirmed `Equipments`, non-cancelled) listing appears
  multiple times in one source booking **on the same date range**, use a single
  line with `quantity` equal to the count (different ranges are rejected — see
  next). **Cancelled or quoted ghost lines stay `quantity = 0` regardless of
  repeat count** — a quoted `Product (x2)` or a cancelled duplicate must not
  become a capacity-consuming booking.
- **One line per `(attendee, listing)` — sum only _identical_ ranges; reject the
  rest.** The attendee edit form de-dupes lines by `listing_id` (`parseLines` /
  `buildFormLines` keep one row per listing) and the logistics/check-in/refund
  helpers update by `(attendee_id, listing_id)`, so the system **cannot
  represent two lines for the same listing under one attendee**. A single line
  also applies one `quantity` to **every** day in its `start_at`…`end_at`
  interval — the daily calendar/capacity treat it as an occupied interval
  (`getDailyListingAttendeeDates` expands every covered day;
  `getDailyListingAttendeesByDate` selects by overlap). So the planner may **sum
  quantities only when the repeats have the _identical_ date range** (e.g. two
  of the same listing on the same dates → `quantity = 2`). **Any differing range
  — adjacent (Jan 1 + Jan 2), overlapping, or non-contiguous (Jan 1 + Jan 10) —
  is unrepresentable and must be rejected** (reported), never widened: widening
  applies the summed quantity to every day in the span, overstating capacity on
  each day (and the edge days for overlaps). Note the collapse/rejection in the
  import report. (Emitting two dated rows for one listing would also be
  _rejected_ by the unique `(listing_id, attendee_id, start_at)` index and would
  break the first admin edit/action.) **Dedupe in the planner — do not lean on
  the database constraint.**

## Zero-Quantity ("No Quantity") Booking Lines

The importer represents two kinds of "matched a product, but it did not actually
consume a slot" with a `listing_attendees` line whose **`quantity = 0`**, rather
than omitting the line. This resolves the cancelled-vs-orphan tension (a
cancelled booking with no lines would be auto-purged as an orphan, see
[orphan note](#all-or-nothing-write-strategy)) and generalises to
"interested-in" products. The importer writes a quantity-0 line for:

- **Non-capacity-status rows** — every matched product on a booking whose source
  `Status` is one the schema declares non-capacity (`event_bookings`:
  `Cancelled` and `Quote`) — including a quote-status row's populated
  `Equipments`, which was quoted for, not booked.
- **Interested-in / quoted products** — products parsed from the
  `Quoted for
  Products` notes block (matched to real listing names like
  `Equipments`, but stored at `quantity = 0` because the customer was only
  quoted, not booked).

These lines recognise no money (the importer posts no ledger legs for a
quantity-0-only booking, see [Financial Mapping](#financial-mapping)), add
nothing to `booked_quantity` (`SUM`), and the attendee keeps a real line so it
is **not** an orphan and its products stay structured/matched.

> **`quantity = 0` is a cross-cutting feature that shipped as PR #1366** ("Add
> no-quantity booking lines"): the shared `TICKET_COUNTS_PREDICATE`
> (`quantity > 0 AND kind = 'attendee'`), the owner "no quantity" checkbox +
> save-path guards, and the full reader/writer/action exclusions all exist in
> main, locked in by the feature's own tests. **The importer is a consumer of
> it** — it writes `quantity = 0` lines; only the _importer-specific_ additions
> remain (see Phase 6). This plan deliberately does **not** re-document those
> shipped surfaces, so it can't drift from the code.

## Quantity-0 Sentinel: Reader/Writer Audit

Shipped with the no-quantity feature (#1366); the code and its tests
(`test/integration/no-quantity-audit.test.ts` and the
`attendees.no-quantity-tickets` story) are the source of truth. Rule of thumb:
operational, public, and capacity surfaces exclude `quantity = 0`; admin
record/detail views keep the rows but guard their per-row actions (check-in,
refund, resend). This importer plan intentionally does not duplicate the surface
list.

## Financial Mapping

**All money now projects from the immutable double-entry `transfers` ledger**
(merged from main). `listing_attendees.price_paid`, `attendees.price_paid`,
`attendees.remaining_balance`, and `modifiers.total_revenue` are **gone** — a
listing's income, an attendee's owed balance, a booking's amount-paid, and a
modifier's revenue all project from the ledger (`shared/accounting/queries.ts`).
So the importer records historical money by **posting transfers**, never by
writing those (now removed) columns.

**Model: each imported listing costs zero; tie the price to the attendee.** A
real checkout posts a `sale` leg per listing (`attendee → revenue:<listingId>`,
gross) plus a `payment` leg (`external:world → attendee`). The importer
deliberately does **not**, because (a) the `event_bookings` CSV is order-level —
one `Total`/`Received`/`Balance`, no per-line prices, so per-listing revenue
can't be reconstructed; and (b) historical imports shouldn't inflate live
listing income or real-cash reports. Instead:

- Add a new ledger account **`imported`** (e.g. `imported:default`,
  `shared/accounting/accounts.ts`) — a contra/clearing counterparty for imported
  money, like `writeoff`. It is **not** `revenue` (so every listing stays at £0
  from imports) and **not** `external:world` (so imports never show as real cash
  in/out).
- Per imported booking **with ≥1 real (`quantity > 0`) line**, post legs tied to
  the **attendee** account, one event group, dated to the source business time,
  with import-specific `kind`s (e.g. `import_owed` / `import_paid`, so they
  never match the live `sale`/`payment`/`refund_cash` report buckets). A
  **quantity-0-only** import (any non-capacity-status row — `Cancelled` or
  `Quote`, whatever its `Equipments` — or a quote with only interested-in lines)
  posts **nothing** — it recognises no money, so its owed balance projects as £0
  and it is never publicly payable:
  - **owed:** `attendee → imported:default` for the order **`Total`** — the
    attendee owes the full booking price.
  - **paid:** `imported:default → attendee` for **`Received`** — the
    historically paid amount, offsetting what they owe.
  - Net `balanceOf(attendee) = Received − Total`, so the projected owed balance
    is `−balanceOf(attendee) = Total − Received` (via `attendeeOwedSubquery`),
    with **no `remaining_balance` column** to set. **Preflight consistency
    check:** the projected owed is `Total − Received`, which need **not** equal
    the source `Balance` column — a legacy export can carry refunds,
    adjustments, or rounding that make `Balance ≠ Total − Received`.
    `Total`/`Received` are **authoritative** (they are what gets posted); if
    `Total − Received ≠ Balance` the row is a **preflight consistency error**
    (reported with all three figures) so the operator reconciles the source,
    rather than the importer silently posting an outstanding amount that differs
    from the CSV's `Balance`. The check applies to **money-posting candidates
    only** — a non-capacity-status (quantity-0-only) row posts no legs, so its
    figures are audit metadata and inconsistency there is a reported warning,
    not a blocker. (See the paid-then-refunded bullet below for why
    `event_bookings` carries no refund signal to reconcile against.) Public
    payability is then gated as for any booking — by the resolved status's
    `is_reservation` flag at the pay page — so a reservation import is payable
    for exactly its outstanding balance, while a non-reservation status with a
    residual balance still records the owed amount faithfully in the ledger (for
    the admin record) but isn't offered publicly. Drop a leg whose amount is 0
    (a fully-paid import posts no owed remainder; a £0 booking posts nothing).
- **No `revenue:<listing>`, `fee`, or `external:world` legs.** Imports recognise
  zero listing revenue and zero booking-fee income and touch no real cash —
  which sidesteps the per-line revenue split entirely (every listing costs zero)
  and leaves live income/cash reports undistorted.
- **Business time = source `Date Booked`** (`occurredAt`), so an imported
  booking lands in its own historical period; the range-scoped Ledger page
  doesn't read it as today's activity. The import-specific `kind`s
  (`import_owed`/`import_paid`) keep imports out of the `income`, `refunded`,
  and `fees` headline buckets (which filter on specific kinds), but the
  **`due`** headline (net receivable) is kind-agnostic, so an imported booking's
  owed/paid legs **do** contribute to `due` for any range covering its
  `Date Booked` — the intended, faithful outstanding figure.
- **Idempotent.** Derive each booking's ledger `eventId` from its
  `(schema, old_id)`, so the event group and per-leg `reference`s are
  deterministic and a re-import replays as a no-op (the importer also skips
  already-mapped rows). Stamp `listing_attendees.ledger_event_group` (the column
  main added) with the booking's event group, tying each line to its booking's
  legs; per-listing amount-paid then projects to £0, which is the intended
  "listings cost zero".
- **Teach the balance summaries the import-paid projection.**
  `getAttendeeOrderSummary` derives `depositPaid` from the **per-line**
  `pricePaidFromLedger` (sale legs only) and `fullPrice = depositPaid + owed`,
  so with no change a fully-paid £100 import would show _paid £0 / full £0_ on
  the admin balance panel and the `/pay/:token` recap, and a part-paid import
  would show paid £0 with "full price" equal to just the remainder. Extend the
  summary (and any surface deriving amount-paid the same way) with an
  **attendee-level import-aware projection** — the sum of the attendee's
  `import_paid` credits (`imported:default → attendee` legs) folded into
  `depositPaid`, with `Total` (owed + paid) as the full price — and add a
  regression covering the fully-paid and part-paid import cases on both pages.
- **Post inside the all-or-nothing import transaction via `postTransfersTx`.**
  Build one transfer group per booking and post it with
  **`postTransfersTx(tx, legs)`** — the tx-scoped primitive that executes its
  inserts **through the importer's own transaction** — so a later
  answer/audit/import-map failure rolls the legs back too. Do **not** use
  `postTransferGroups`/`postTransfers` here: they run their own read-only
  prepare + a **self-committing `executeBatch`** apply (no caller-tx parameter),
  so their legs would commit independently and **survive** the importer's
  rollback, breaking all-or-nothing for money (`postTransferGroups`'s own doc
  points nested callers at `postTransfersTx`). `postTransfersTx`'s conflict
  check reads the ledger _through_ the transaction, so a concurrent re-post of
  the same event replays as a no-op without needing `INSERT OR IGNORE`.
- **Later settlement stays real and ledger-native:** when the customer pays the
  outstanding balance, `settleAttendeeBalance` posts a real
  `external:world →
  attendee` `payment` leg guarded by the projected owed
  amount — so the _actual_ later payment is recorded as real cash, even though
  the historical import wasn't.
- **A source row that was paid then refunded:** the `event_bookings` export has
  **no refund column**, so the importer cannot detect "paid then refunded" from
  `Total`/`Received`/`Balance` alone — such a row appears either as a
  `Cancelled` row (a quantity-0 ghost that recognises nothing, whatever its
  figures) or with the refund already **netted out** of `Received` (in which
  case the figures reconcile and it imports as an ordinary partial/unpaid
  booking). Rows whose figures _don't_ reconcile are exactly the preflight
  consistency error above — the operator fixes the source. The
  owed/paid-then-**reversal** posting (mirroring the backfill's
  full-reversal-for-refunds, under a derived refund event group) is reserved for
  a future schema whose `SchemaDefinition` includes a **refund detector**
  (explicit refund columns + a reconciliation equation); `event_bookings` does
  **not** use it.
- Preserve raw `Total`/`Received`/`Balance`, payment columns, and modifier
  columns in the durable encrypted audit trail (see
  [Where Legacy Metadata Goes](#where-legacy-metadata-goes)); the import report
  summarises them but is not their system of record.

Do not create `processed_payments` rows for historical CSV payments (that table
is provider idempotency, not a ledger), and do not post `fee` or `modifier` legs
for imports (the CSV's modifier/payment columns are audit metadata, not ledger
events).

## Status Mapping

Use the source `Status` column.

- Load existing `attendee_statuses` and resolve each non-skipped source row's
  `Status` value to an existing status by normalized exact name.
- Use the resolved status id when creating the attendee.
- If any source `Status` value is missing locally, block the whole upload before
  writes, list the missing statuses, and ask the operator to create matching
  statuses before retrying.
- **Reject ambiguous status matches.** `attendee_statuses.name` is encrypted and
  not unique, and the settings form only requires a non-empty name, so two local
  statuses can normalize to the same name (e.g. two `Confirmed`s) with different
  `is_reservation` / `is_paid_default` flags that drive balance-payment
  behaviour. If a source `Status` matches more than one local status, block the
  upload as an ambiguous-setup error rather than picking a row — the same rule
  as free-text questions.
- Import cancelled and quote-status rows too, but give them **zero-quantity
  booking lines**, not capacity-bearing ones. The `SchemaDefinition` declares
  which **source** `Status` values are non-capacity (`event_bookings`:
  `Cancelled` and `Quote` — a quote was prepared, not booked, and capacity is
  status-blind, so a real line would consume calendar capacity for an
  unconfirmed booking). Such a row becomes an attendee with its matching local
  status, and its matched products are written as `listing_attendees` lines with
  `quantity = 0` (see
  [Zero-Quantity Booking Lines](#zero-quantity-no-quantity-booking-lines)). The
  listing-aggregate triggers add `NEW.quantity` to `booked_quantity`, so a
  quantity-0 line consumes **no** capacity (capacity in this system is
  status-blind — there is no capacity-freeing status flag, only
  `is_reservation`/`is_paid_default`), while still leaving a real line so the
  attendee is not an orphan and the products stay structured/matched. With the
  `tickets_count` change in the Zero-Quantity section, these lines also leave
  `tickets_count` and `income` untouched. Note the cancelled row in the import
  report.
- Preserve `Colour Name` as a free-text answer / in the import report, but do
  not use it for status resolution.
- Do not add status aliases or fuzzy matching. The operator is responsible for
  setting up local statuses with matching names.

## Custom Questions

This section replaces the old "Custom Questions And Import Notes" plan now that
free-text questions exist (PR #1335). Use free-text custom questions as the home
for every legacy column we want surfaced and searchable per booking.

**Public vs staff-only questions.** Assigning a question to a listing also puts
it on that listing's **public booking form** (`getQuestionsWithListingIds` feeds
the public path), so importing an internal legacy column (`Colour Name`, invoice
numbers, alternate phone, contact-vs-delivery address) as an ordinary assigned
question would start asking _future customers_ for it. To avoid that, free-text
questions used for import gain a **staff-only flag** (admin/import-only): a
staff-only question still renders on the **admin attendee edit form** and holds
answers, but is **never shown on the public booking form**. This is a required
addition to the free-text-question feature (PR #1335) — the importer depends on
it. Operators mark genuinely customer-facing columns (the party questions,
`Surface`, `Age Group`) as normal public questions, and import-only columns as
staff-only.

**The staff-only filter must apply to _every_ public consumer of questions, not
just the rendered booking form.** In particular, QR direct-checkout gating:
`listingSupportsDirectCheckout` (`src/shared/qr.ts`) calls
`getQuestionsForListing` and disables the scan-to-checkout shortcut whenever a
listing has _any_ assigned question. Because import-only questions must be
assigned to the booking's listing (to render on the admin edit form), a
staff-only question would wrongly switch affected listings out of QR
direct-checkout even though buyers never answer it. So the
staff-only/public-visible filter has to be threaded through
`listingSupportsDirectCheckout` (and any other gating that counts assigned
questions) — staff-only questions must be invisible to the _entire_ public path:
render, validation, **and** QR/checkout gating.

Setup contract (operator's responsibility, mirrors products/statuses):

- For each CSV column the operator wants imported, they create a question whose
  `display_type` is `free_text` and whose text matches the CSV header exactly
  (after normalization). The create form is `POST /admin/questions` with `text`
  and `display_type` fields.
- The question must be `assign_all`, or assigned to at least one listing the
  booking matched, so the imported answer actually renders on the attendee edit
  form. **A matched free-text question that is assigned to none of the booking's
  listings is a blocking validation error, not a warning.** Storing a hidden
  answer would be a data-loss trap: the admin edit form only renders questions
  assigned to the booking's listings, and the save path (`saveAttendeeAnswers`)
  replaces an attendee's whole answer set from the _rendered_ form — so the
  first admin edit of that attendee would silently delete the unrendered
  imported answer. Blocking forces the operator to fix the assignment before the
  data is written, which fits the importer's "all setup must exist first"
  stance. The **staff-only flag** is what makes this assignment safe for
  internal columns: the question must still be assigned (so it renders on the
  admin edit form and isn't dropped on save), but the flag keeps it off the
  public booking form. For a cancelled/quoted import whose every matched line is
  `quantity = 0`, assignment alone still isn't enough unless the edit form keeps
  quantity-0 lines in its question loading — which the shipped feature does:
  `loadQuestionsForExisting` (`src/features/admin/attendee-page-data.ts`)
  derives its listing ids from **all** of the attendee's bookings with no
  quantity predicate. That must stay so — a `quantity > 0` filter there would
  silently drop a no-quantity-only attendee's imported answers on the first
  save.

Resolution (pure, before any writes):

- Decrypt existing question text and build a normalized-exact lookup of
  `free_text` questions only. Radio/select questions are not import targets.
- **Duplicate normalized text is an ambiguous-setup error, not a silent pick.**
  The `questions` table does not enforce unique text, so two `free_text`
  questions can normalize to the same header. If a CSV header matches more than
  one, block the upload and tell the operator to disambiguate (rename or remove
  the duplicate) — never guess which one to attach the answer to. This is the
  same no-silent-matching rule the product resolver follows.
- Split the importable-column config into **required question columns** and
  **optional audit-only columns** — the blocking rule below applies only to the
  former. Otherwise the hard-coded list would force the operator to create a
  free-text question for _every_ non-empty legacy column even when they intend
  it to live only in the encrypted audit trail (see Where Legacy Metadata Goes),
  so the first upload could never proceed.
- For each configured **question** column with a non-empty value, look up the
  matching free-text question. Normalize and **trim** the value (the public path
  trims free-text answers via `parseFreeTextAnswer`; match that so dedup keys
  line up).
- If a non-empty **required-question** column has no matching free-text
  question, block the upload before writes and list the missing question text on
  the missing-setup page (link to `/admin/questions`). A non-empty
  **audit-only** column with no question is **not** a setup error — its value
  goes to the encrypted audit trail.
- Dedupe per booking: at most one text answer per `(attendee, question)` — the
  schema's unique `(attendee_id, question_id)` index enforces this, so the
  planner must not emit two answers for the same question on one booking.
- **Conflicting duplicate columns are a source-data error, not a silent drop.**
  The parser deliberately preserves duplicate headers, so two columns (e.g. two
  `Surface` columns) can map to the same free-text question on one row. If they
  hold the _same_ trimmed value, collapse to one answer. If they hold
  _different_ non-empty values, the schema can only keep one
  `(attendee, question)` answer — so the planner must flag the row as an
  ambiguous source-data error rather than arbitrarily keeping one value and
  dropping the other.

Writing (in the whole-file transaction — see
[All-Or-Nothing Write Strategy](#all-or-nothing-write-strategy)):

- Collect every distinct trimmed answer text from the **candidate import plan
  only** — never the whole file. Already-imported and non-creatable rows are
  removed from the candidate set before writing, so collecting across the whole
  file would upsert encrypted `strings` for bookings that get no
  `attendee_answers` rows, leaving them stranded at `used_count = 0` and outside
  rollback cleanup. Resolve the candidate texts to a `text → stringId` map in
  one step (see the writer note below for keeping this in-transaction). This
  still dedupes identical answers across the candidate bookings into a single
  encrypted `strings` row (e.g. 200 imported bookings answering `Grass` to
  `Surface` share one row), and uses only the owner public key.
- Emit `INSERT ... attendee_answers (attendee_id, question_id, string_id)` rows
  into the importer's single batch, using the resolved `stringId` and the
  matched `question_id`. Do **not** call `saveAttendeeAnswers` — even once for
  the whole file: it opens a transaction **of its own**, which commits
  separately from the importer's, so it would break whole-file atomicity (the
  answer-equivalent of the existing "don't call `createAttendeeAtomic` per row"
  rule). Resolving the string ids and then doing direct `attendee_answers`
  inserts mirrors what `ticket-submit` does on the paid path. Pass the
  importer's own `TxScope` to `getOrCreateStringIds`, so the string upserts roll
  back with everything else. See the
  [write-strategy notes](#all-or-nothing-write-strategy).
- The `string_id` insert trigger maintains `strings.used_count`; the importer
  writes nothing to that column.

Good first-pass free-text question columns:

- `Is your party for a boy or girl?`
- `Do you require Extra Extra Coconuts?`
- `Do you require us to supply the toys?`
- `Do you Require Supervision?`
- `Exhibition: Please supply stand / hall number ...`
- `Surface`
- `Age Group`
- `Heard About`
- `Occasion`
- `Purchase Order Number (If Applicable)` (empty in the sample, but keep in the
  plan)

Now that free-text questions exist, several columns the old plan dumped into a
notes blob become first-class importable questions instead, if the operator
chooses to create them: `Colour Name`, contact-vs-delivery address, alternate
phone, invoice fields (`Invoice ID`, `Invoice Reference`, `Invoice Date`). These
are internal, not customer-facing, so they must be created as **staff-only**
free-text questions (see Public vs staff-only above) — otherwise assigning them
to a listing would put them on the public booking form. They remain optional —
only columns with a matching free-text question are imported as answers;
everything else is left for the audit trail.

## Where Legacy Metadata Goes

There are now three possible destinations; pick per column by value:

1. **Free-text question answers** (preferred for anything worth surfacing and
   per-booking searchable): the configured columns above, via the PR #1335
   mechanism.
2. **Structured attendee fields**: name, email, phone, address, status,
   remaining balance, dates/times — as in [Booking Mapping](#booking-mapping).
3. **Raw audit trail** (low-value-but-keep): historical `Payment: ...` columns
   and dates, modifier columns, raw `Total`/`Received`, and any leftover legacy
   fields. The original plan appended a labelled block to a per-attendee `notes`
   column:

   ```text
   Imported booking metadata
   Status: ...
   Colour: ...
   Surface: ...
   Customer notes: ...
   Operator notes: ...
   Payments: ...
   Modifiers: ...
   ```

   Keep this idea. The destination is now **decided**: the notes rework landed
   as the per-attendee **`system_notes`** table, so the raw audit dump goes to a
   `system_notes` **owner** note (`createOwnerNote`, owner-public-key). That a
   durable encrypted destination exists is a **hard prerequisite for enabling
   the writer**, and it now does. The import report is an ephemeral page, so it
   is **not** a system of record: if `Customer Notes`, `Operator Notes`,
   payment/modifier history, etc. are only shown in the report, a successful
   import permanently loses them once the page is gone. So: every audit-trail
   field must be written to `system_notes` before a booking is created, and the
   writer must **block** an import that carries unmapped audit fields rather
   than dropping them — never import with data loss. The report only
   _summarises_ what was persisted.

Do not add a product/status/question alias mechanism. Matching is normalized
exact matching everywhere.

## All-Or-Nothing Write Strategy

Do not call `createAttendeeAtomic` once per CSV row and consider the whole file
atomic. That helper is atomic per attendee/order, not across an entire upload.
The same warning applies to `saveAttendeeAnswers` — do not call it per attendee.

Target algorithm — a **pure preflight** that accumulates the full report, then
**one decision**, then (only if the report is clean) the write:

**Preflight (pure; appends to one report, never fail-fast — principles 2–4):**

1. Parse the CSV into indexed rows (engine + the schema's parser config).
2. Validate required columns and row shape per the schema; record any problems.
3. Load context once, read-only: listings, statuses, and free-text questions,
   plus the import-map rows **only for the candidate ids** —
   `SELECT … FROM
   booking_imports WHERE schema = ? AND old_id IN (…)` over
   the CSV's `old_id`s, not the whole table (a site with years of imports would
   otherwise scan/decrypt all prior history just to skip the few ids in this
   file).
4. Classify against the import map (scoped to the active schema): **skip** rows
   whose `(schema, old_id)` is already mapped.
5. Record duplicate `old_id`s as source-data errors — but evaluated only over
   rows that are still **creatable candidates** after the import-map skip
   (step 4) _and_ the non-creatable classification (step 6): a re-upload whose
   duplicates are all already-imported skips them harmlessly, and a duplicate
   contributed only by a skipped or non-creatable (zero-products/blank) row must
   not block the valid row that shares its id. Two _creatable_ rows sharing an
   `old_id` remain a blocking error — the importer can't tell which is
   authoritative. (Listed here in reading order; the check runs once the
   candidate set is final.)
6. Resolve products for the remaining rows. A row that resolves to **zero**
   products is **non-creatable** (no line could be written) — recorded and
   dropped from the candidate set. Unmatched names, `standard`-type matches, and
   names matching **>1** listing are recorded as missing / ambiguous setup.
7. Resolve source `Status` values to existing statuses; record missing and
   ambiguous (>1 match) statuses.
8. Resolve the schema's question columns to existing `free_text` questions by
   normalized exact text; record missing required questions and ambiguous
   matches.
9. Validate dates, quantities, money, and **required-value** fields with the
   schema's per-field validators; record failures keyed to the offending row.
   Optional-value fields fall back instead of failing (e.g. `Date Booked` →
   import time). Do **not** preflight capacity — legacy imports may overbook.
10. Resolve free-text answers from the **candidate set only** (not the whole
    file — already-imported and non-creatable rows are excluded, so collecting
    across the file would strand encrypted `strings`); dedupe identical answers
    across candidates. Record conflicting duplicate columns (same question, two
    different non-empty values) as source-data errors.
11. Check representability: a same-listing repeat across **non-identical** date
    ranges (anything but the exact same range) can't fit one
    `(attendee, listing)` line and is recorded as unrepresentable (see
    Quantity).
12. **Build the import plan** for every still-creatable candidate — **raw**
    (unencrypted) contact/PII payloads, lines (real / quantity-0), text-answer
    sets, owed/paid figures, dates/times, audit fields, idempotency keys. **Pure
    data, no writes and no crypto:** PII encryption needs the owner public key
    and fresh randomness (nondeterministic), so it belongs in the effectful
    write phase, not the pure planner — the writer encrypts the raw payloads via
    `buildPiiBlob` as it inserts. Keeping the plan raw also keeps it
    deterministic and unit-testable.

**Decision.** If the report has any **blocking error**, stash the whole report
server-side and redirect to the error report with only a `?stash=` token (see
Proposed Routes And UI) — **no writes have happened**, and the page lists
_every_ blocking problem at once. Skips/warnings alone do **not** block: with
only already-imported and non-creatable rows, the valid candidates still import
and the skips are reported on the success page. Tests assert the redirect
carries a token (not a param list), that a file with several distinct blocking
problems surfaces them all (not just the first), and that one
blank/non-creatable row among valid bookings imports the rest and reports the
skip.

**Write (one guarded transaction, only when the report is clean):**

13. Run one write transaction for all candidates in the plan. **Re-verify the
    resolved context inside the transaction before writing — by re-running the
    resolvers, not by field-checking the chosen rows:** the plan was built from
    a preflight snapshot, and the setup can change between preflight and write
    (another admin deleting, renaming, re-flagging, or **adding** a listing /
    status / question). Ambiguity is a property of the **whole current setup
    set**, not of the chosen row — a duplicate status or question name, or a new
    listing that makes a slash-token ambiguous, leaves the originally chosen
    row's own fields intact while the documented resolver would now block. So:
    load a fresh snapshot **through the transaction**, re-run the same pure
    resolvers over it, and require **identical results** — the same unique match
    for every product / status / question (no new ambiguity, no lost match), the
    same rule branches satisfied under **current** state (the question still
    `free_text` with the required staff-only visibility and still `assign_all`
    **or** assigned to ≥1 matched listing — the same rule as preflight, not a
    bare assignment check; the listing still daily-type, and the CSV span still
    valid against the listing's **current** `customisable_days`/`duration_days`
    — a listing switched from customisable to fixed must re-pass the
    fixed-duration span gate), and the same status
    `is_reservation`/`is_paid_default` flags. Any difference aborts — the whole
    file rolls back and the operator re-runs preflight against current state,
    rather than the importer writing against setup that no longer matches the
    CSV. (Reusing the pure resolver on a fresh snapshot keeps this one code
    path, per the shared-interface rule — no parallel "recheck" logic to drift.)
    Then:
    - upsert the deduped `strings` rows and resolve their ids (or do this such
      that a rollback removes them);
    - insert attendee, and resolve its **stable id** via a per-attendee lookup
      key, not `last_insert_rowid()` (see implementation notes);
    - **fire no registration side-effects.** A bulk import of historical
      bookings must not call `logAndNotifyRegistration` (or its parts): no
      customer registration emails, no registration webhooks, no built-site
      assignment, and no renewals — `logAndNotifyRegistration`
      (`shared/webhook.ts`) writes a per-booking `logActivity` entry and queues
      **four** items (`sendRegistrationWebhooks`, `sendRegistrationEmails`,
      `assignAndNotifyBuiltSites`, `applyRenewalsForEntries`) via
      `addPendingWork`. The importer writes rows directly and stays silent;
      contacting customers or mutating built-site/renewal state for old or
      quantity-0 rows would be wrong;
    - insert each `listing_attendees` line — `quantity = 0` for cancelled rows
      and for interested-in/quoted products, a real quantity otherwise (every
      candidate writes at least one line, so no attendee is an orphan);
    - write logistics times if used — **only on real (`quantity > 0`) lines**;
      cancelled/quoted ghost lines get no `start_time`/`end_time` (the
      no-quantity spec clears logistics on quantity-0 lines, so a stale time
      would resurface on a later reactivation/agent assignment). Keep ghost-row
      source times in audit metadata only;
    - **post the booking's money to the `transfers` ledger** — only for
      candidates with ≥1 real (`quantity > 0`) line. Build one transfer group
      per booking (`attendee → imported:default` for `Total`,
      `imported:default → attendee` for `Received`, zero-amount legs dropped,
      `eventId` derived from `(schema,
      old_id)`, `occurredAt` = the
      booking's **resolved** created timestamp — the parsed `Date Booked`, or
      its import-time fallback when the value is missing/unparseable, i.e. the
      exact value written to `attendees.created`, so an optional-value row can't
      feed `postTransfersTx` an invalid date) and post it via
      **`postTransfersTx(tx, legs)`** — the tx-scoped primitive — **inside this
      transaction**, so a rollback unwinds the legs. (Not `postTransferGroups`,
      which self-commits its own batch and would survive the rollback — see
      Financial Mapping.) Stamp each inserted line's `ledger_event_group` with
      the booking's event group. Post **no**
      `revenue:<listing>`/`fee`/`external:world` legs (see
      [Financial Mapping](#financial-mapping)); a quantity-0-only candidate
      posts nothing;
    - insert `attendee_answers(attendee_id, question_id, string_id)` text-answer
      rows using the resolved string ids;
    - persist the raw audit-trail fields to their durable encrypted destination
      — the per-attendee `system_notes` owner note, written as INSERT statements
      **inside this transaction** (owner-public-key encryption done up front;
      **not** the standalone `createOwnerNote`, which executes outside any
      caller transaction and would survive a rollback);
    - record a visit **and** increment `admin_booking_count` for candidates that
      have ≥1 real (`quantity > 0`) line — atomic booking activity bumps both
      `visits` and `admin_booking_count`, so incrementing only `visits` would
      leave `/admin/history/:hmac` omitting imported bookings (see the resolved
      decision) — but **not** for cancelled or quote-only (quantity-0-only)
      candidates. Do **not** reuse the live booking statements as-is: they set
      `last_activity = nowMs()`, which makes an old imported booking look
      freshly active to `pruneContacts`. Increment `visits` and
      `admin_booking_count` (imports are admin-initiated) using the **source
      booking date** (`Date Booked`, with the same import-time fallback as
      `created`) while keeping the **newer** timestamp —
      `last_activity = MAX(existing.last_activity, source)` — so import never
      moves a recently-active contact backwards into prune range nor refreshes a
      stale one;
    - insert `booking_imports(schema, old_id, new_id)` — always write the active
      schema (the `schema` key column is `NOT NULL` and `(schema, old_id)` is
      the idempotency key).
14. If any insert fails, the transaction rolls back and no attendees, listing
    lines, text answers, new `strings` rows, audit-trail records, visit counts,
    posted `transfers` legs, or import-map rows survive. Preflight should have
    made this reachable only by genuinely unexpected/infrastructural failure.

Implementation notes:

- `executeBatchWithResults` runs one libsql batch transaction, but guarded
  inserts can fail by affecting zero rows rather than throwing. The importer
  should bypass capacity guards for legacy rows, and still needs either:
  - a transaction helper that can inspect each statement result before commit
    and throw to roll back, or
  - batch statements that deliberately abort the transaction when any expected
    insert did not happen.
- **`strings` writes must be atomic with the import — do not leave orphans.**
  `getOrCreateStringIds` runs its `INSERT OR IGNORE` _before_ any
  `attendee_answers` insert, and it takes an optional `TxScope`. Called
  **without** that handle it commits on its own, so it would persist every
  distinct imported answer (notes, addresses, invoice fields — encrypted source
  PII) even when the main transaction later rolls back. Those rows are created
  with `used_count = 0` and never referenced by `attendee_answers`; the delete
  trigger only **decrements** `used_count`, so they linger until the
  **age-based** `pruneUnusedStrings` sweep
  (`used_count = 0 AND created < cutoff`) eventually reaps them. A failed
  "all-or-nothing" import would therefore leave imported PII sitting in
  `strings` until that sweep — breaking both atomicity and the privacy stance,
  so it is **not** acceptable. The writer must do one of:
  - pass the guarded transaction's `TxScope` to `getOrCreateStringIds` and
    resolve the ids within it, so a rollback unwinds them too (preferred); or
  - on any failure/rollback, explicitly delete the strings it newly created that
    are still at `used_count = 0`. Either way, a rolled-back import must leave
    **zero** new `strings` rows.
- **Use a stable per-attendee id to wire up child rows — never
  `last_insert_rowid()` in a multi-row batch.** `last_insert_rowid()` advances
  after every insert in the batch, so the second attendee's `listing_attendees`,
  `attendee_answers`, audit, and `booking_imports` rows would attach to the
  wrong attendee. The existing create path solves this
  (`src/shared/db/attendees/
  create.ts`): each attendee gets a generated
  `ticket_token_index`, and child inserts resolve the parent id with
  `(SELECT MAX(id) FROM attendees WHERE
  ticket_token_index = ?)`. The importer
  must generate a distinct `ticket_token_index` per source booking and key every
  child insert off it (or use an equivalent `RETURNING` strategy if the helper
  moves to one).
- **Orphan auto-purge interaction.** `orphan-attendees.ts` (`ORPHAN_IDS`) treats
  any attendee with no `listing_attendees` rows as a purgeable orphan, and
  auto-purge is on by default; it deletes the attendee and its
  `attendee_answers` but leaves `booking_imports`, so a purged import could
  never be re-created (its `old_id` stays in the map). Writing ≥1 line per
  attendee — `quantity = 0` for cancelled/interested rows (see
  [Zero-Quantity Booking Lines](#zero-quantity-no-quantity-booking-lines)) —
  stops imported attendees being orphans **at import time**, but it does not
  cover _later_ orphaning: `deleteListing` removes a listing's
  `listing_attendees` rows and deliberately keeps the attendee, so an import
  whose last listing is later deleted becomes an orphan and gets purged — and
  the purge still leaves its `booking_imports` row, permanently blocking
  re-import. **So the purge/delete flow must clean up `booking_imports` **only
  when the attendee's capacity is actually released**, keyed by `new_id`
  (`DELETE FROM booking_imports WHERE
  new_id IN (…)`, since it's keyed by
  `new_id`, not `attendee_id`):
  - **Orphan auto-purge** and **`deleteAttendee` with `releaseBookings: true`**
    fully remove the attendee and release its aggregates, so delete the mapping
    — the `old_id` is freed and a re-upload cleanly recreates the booking.
  - **`deleteAttendee` with `releaseBookings: false` (held delete)** deletes the
    lines but _keeps_ the listing aggregates held (it restores them — see
    [Zero-Quantity](#zero-quantity-no-quantity-booking-lines)). Here the mapping
    must be **kept as a tombstone**: if it were freed, a re-upload would
    recreate the lines and increment the already-held aggregates a _second_ time
    (double-count). The booking stays "imported" and is not re-creatable until
    the held capacity is released. **Caveat — this holds only for
    aggregate-based capacity (standard listings); imports are daily-only, where
    capacity / calendar / logistics read the dated `listing_attendees` rows
    directly, not the restored aggregate.** A held delete removes those rows, so
    a daily import has no operational presence afterwards while the tombstone
    blocks re-import forever — the worst outcome. For daily held-deletes, either
    keep a real held row (so the aggregate and the row agree) or, preferably,
    **fully release** the aggregate (don't hold it) and **free/remap** the
    mapping when the dated row is removed, so a re-upload cleanly recreates the
    booking without double-counting.
  - **`deleteListing`** deletes the listing's `listing_attendees` rows outright
    (releasing aggregates immediately) and keeps the attendee. By the
    capacity-released principle above, free the mapping **here too** for any
    attendee this leaves with zero lines
    (`DELETE FROM booking_imports WHERE
    new_id IN (newly-orphaned ids)`)
    rather than waiting for orphan auto-purge, which may be disabled or
    age-gated: until it runs, the attendee holds no capacity yet its `old_id`
    would still block a clean re-import.
  - **Money-bearing imports: ledger legs outlive the mapping → permanent
    tombstone.** Freeing the mapping does **not** remove the append-only
    `transfers` legs already posted for `(schema, old_id)`: the ledger
    `eventId`/`reference`s are derived from that same key, while the stored legs
    reference the now-deleted `attendee:<id>` account. **Reversing the legs does
    not fix this** — the ledger is append-only, so a reversal only adds
    compensating legs under a _different_ event group and leaves the
    **original** legs in place under `(schema, old_id)`. A later re-upload
    re-derives that same event group and posts legs with the **same references
    but a new attendee account**; `postTransfersTx` → `assertEventMatches`
    matches by reference and then rejects on `legIdentityDiff` (the source/dest
    account differs), so it **hard-errors** (`LedgerConflictError`) instead of
    recreating the balance. The deterministic references can't be re-keyed
    without breaking same-CSV idempotency, so a **confirmed (money-bearing)**
    import must **keep its mapping as a permanent tombstone** — the `old_id` is
    never freed while its import legs exist, so it is **not** cleanly
    re-importable after deletion (accepted: re-importing deleted paid history
    would need a manual ledger reversal + re-key anyway). A quantity-0/cancelled
    import posts no legs and stays freely re-importable. **This overrides the
    daily free/remap rule above:** a money-bearing _daily_ import also
    tombstones — the capacity reason for free/remap is moot once its dated rows
    are gone, but its ledger legs still block a clean re-import. So the
    mapping-cleanup rule is two-axis: **free** the `old_id` only when the import
    is both zero-money **and** capacity-released; **tombstone** whenever import
    legs exist.
  - **Multi-line imports: a per-booking mapping can't represent partial
    deletes.** Idempotency is keyed on `(schema, old_id)` for the **whole**
    booking, but a source booking can map to several `listing_attendees` lines.
    Deleting **one** matched listing frees that product's line while the
    attendee keeps others, so the `old_id` stays mapped and a re-upload skips
    the **whole** booking instead of restoring the missing product — yet freeing
    the `old_id` would **duplicate** the surviving lines. So free the `old_id`
    only when the delete removes the attendee's **last** import line; partial
    line deletion of a multi-line import needs an explicit strategy — line-level
    import state (`(schema, old_id, listing)`), or **block** deleting individual
    lines of a multi-line import (whole booking or nothing). (Quantity-0 lines
    were still chosen over a `booking_imports`-aware exclusion in `ORPHAN_IDS`
    because they also keep the products structured and matched while the
    attendee is live.)
- **Attendee merge needs special handling.** `applyAttendeeMerge`
  (`shared/merge/attendee-merge.ts`) removes the source attendee with a raw
  `DELETE FROM attendees` (not `deleteAttendee`) and repoints **all** of the
  source's ledger legs onto the target (`repointAttendeeStatements` re-sources
  every `attendee:source` leg to `attendee:target`):
  - **Import map:** **remap** the source's `booking_imports` row to the
    surviving target
    (`UPDATE booking_imports SET new_id = targetId WHERE new_id =
    sourceId`)
    so the old `old_id` stays mapped and a re-upload still skips it. Because
    `new_id` is **not unique** (see Data Model), this works even when the target
    is itself an import — both `old_id`s then point at the merged attendee.
    Never just drop the source mapping (that would let a re-upload recreate a
    duplicate).
  - **Imported money vs. decision 17:** decision 17 resolves a _discarded
    conflicting_ booking's money by un-billing its `sale` leg
    (`revenue:L →
    writeoff`) and crediting / writing-off the over-collected
    cash. Imports post **no** `sale`/`revenue` legs (only
    `attendee ↔ imported:default`), so `bookingSaleAmount` is `0` for an
    imported booking and decision 17 emits no legs — which is _correct_ for
    listing income (an imported duplicate never added any, so there is nothing
    to write down). **But** the wholesale repoint still moves the discarded
    imported booking's `import_owed`/`import_paid` legs onto the target, so two
    _conflicting_ imported bookings would **double-count** the owed balance. The
    importer's merge work must reverse a discarded imported booking's owed/paid
    legs too — teach decision 17 the import leg kinds (un-bill `import_owed`,
    reverse `import_paid`) or post a compensating reversal under a `merge-…`
    key, mirroring how it un-bills a discarded `sale`. (A _moveable_,
    non-conflicting imported booking simply follows the person via the repoint —
    no decision, no double-count.)
  - **Free-text answers:** **already handled by main** — `applyAttendeeMerge`
    loads both attendees' text answers and re-saves them onto the target with
    target-precedence (`mergedTextAnswers` → `saveAttendeeAnswers`), so an
    imported source's legacy `string_id` answers are adopted, not dropped. The
    importer only needs a **test** asserting this holds for an imported source,
    not new merge code.
  - **Audit notes (`system_notes`):** **not** handled by main —
    `applyAttendeeMerge` raw-deletes the source attendee and never touches
    `system_notes`, so the imported audit trail (stored as a `system_notes`
    owner note) would be left orphaned on the deleted source id. The merge must
    **repoint the source's `system_notes` rows to the target**
    (`UPDATE system_notes SET entity_id =
    targetId WHERE entity_type = 'attendee' AND entity_id = sourceId`,
    in the same transaction — the `booking_imports` remap's sibling), with a
    test that a merged imported source's audit note survives on the target. A
    note names the kind of record it is about and which one, so both parts are
    matched; see `src/shared/db/notes/target.ts`.
- The `attendee_answers` XOR/validation triggers will `ABORT` a malformed answer
  row (e.g. both `answer_id` and `string_id` set). The importer only ever writes
  the text-answer shape (`answer_id` NULL, `question_id` + `string_id` set), so
  a trigger abort here means an importer bug, not bad data — let it roll the
  transaction back rather than catching it.
- Keep this design explicit in tests. A late-row failure must leave no earlier
  attendees, listing links, text answers, or import-map rows.

## Missing Setup Error Page

This is the **missing-setup section of the preflight error report** (see
[Preflight & Error Reporting](#preflight--error-reporting)); the same
report/page also carries the ambiguous-setup, source-data, non-creatable, and
unrepresentable problems. The setup section is the part with create/fix links.

Input:

- `GET /admin/imports/:schema/errors?stash=<token>` — the token addresses the
  durable server-side stash written by the upload POST (see Proposed Routes And
  UI); the page reads the report (the missing product/status/question set plus
  the other problem groups) from the stash, not from repeated query params.

Behavior:

- Dedupe and sort missing products, statuses, and required custom-question names
  for display.
- Escape names normally in HTML.
- Render each missing product as a link:
  `/admin/listing/new?import_name=<encoded name>`.
- Render each missing status as its exact required name plus a link to
  `/admin/settings/statuses/new`.
- Render each missing required custom question as its exact required text plus a
  link to `/admin/questions`, with copy telling the operator to create it as a
  **free-text** question with that exact text (optionally a prefilled
  `?import_text=` link, mirroring the listing flow). **Carry the required
  visibility too:** for columns the import config marks as internal
  (`Colour
  Name`, invoice numbers, alternate phone, contact-vs-delivery
  address), the copy/link must say to create the question as **staff-only** (and
  prefill the staff-only flag if the create form supports it) — otherwise an
  operator following the link creates an ordinary _public_ question and the next
  booking form starts asking customers for that legacy/PII field. Equivalently,
  block a public question matching an internal column at resolution. (The import
  config already knows which columns are internal — see Custom Questions.)
- Render each product that matched a **`standard`-type listing** as its name
  plus a link to that listing's edit page (`/admin/listing/:id/edit`), with copy
  telling the operator the listing must be a **daily** listing to import its
  bookings (the importer is daily-only — see Product matching). Store the
  matched listing's **id** (the resolver already has it from the match), not
  just its name, **in the stash payload** — not a `&standard=<id>` query param
  (the page is token-only, and many standard matches would re-bloat the URL) —
  so the GET page can build the `/admin/listing/:id/edit` link and load the
  listing to display its name. Listing names are encrypted at rest and can
  collide after decryption/normalization, so the id can't be reconstructed from
  the name alone. **Store the resolver's convertibility verdict in the stash
  too** (see Product matching): an _empty, ungrouped_ standard listing can be
  converted in place, so the "make it daily" edit-link copy fits; but a
  **populated** listing, or one in a **group with any siblings** (a single
  in-place type change is rejected by `validateGroupListingType` regardless of
  sibling population), is _unconvertible_ — render those in a separate group
  with migrate / ungroup / replace guidance, **not** a plain "edit → make daily"
  link that walks the operator into a save that can't succeed or a retry loop.
  Render these in their own section.
- Include a link back to the upload page.
- Text should tell the user to create the missing setup, then upload the CSV
  again.

The stash holds the **report**, not the source CSV: the missing-setup sets
_plus_, for each non-setup problem (source-data, non-creatable,
unrepresentable), the offending row identifier(s), column name(s), and the
minimal offending value needed to tell the operator what to fix — never the
whole file. The CSV is re-uploaded after the operator fixes everything.

## Tests

Add focused tests before broad route tests:

- **Engine is schema-generic:** the engine/parser/planner/writer carry no
  `event_bookings` literals (a guard test), and a trivial second schema runs the
  whole pipeline end-to-end.
- **Preflight is pure:** preflight performs no writes and returns a report/plan;
  the database is untouched until the write stage.
- **Every problem at once:** a file with missing setup _and_ a duplicate
  `Booking ID` _and_ an ambiguous status returns all three groups in one report
  (not just the first) and writes nothing.
- CSV parser handles BOM, quotes, commas, duplicate headers, repeated `Date`
  columns, and empty cells.
- Product extractor handles:
  - populated authoritative `Equipments`;
  - empty `Equipments` plus `Quoted for Products` fallback;
  - ignoring extra product-looking text in notes when `Equipments` is populated;
  - duplicate product names;
  - names containing slash characters with longest known-name matching first;
  - a listing name that is only a _substring_ of a source token is reported as
    missing, not consumed (e.g. a local `Bull` listing must not match inside
    `Rodeo Bull / Bucking Bronco`).
- Product resolver reports missing names and does not write anything.
- Status resolver maps source `Status` values to existing attendee statuses,
  reports missing status names, and does not write anything. (Cancelled-row
  behaviour is covered in the semantic-correctness tests below.)
- Missing-setup route renders product links with encoded `import_name` params
  and lists missing statuses and missing free-text questions.
- New-listing form locks `import_name` and POST enforces it server-side.
- Import map skips already-imported source IDs.
- Import rejects duplicate source IDs in the same CSV.
- Whole-file transaction rolls back all writes when a later row fails —
  explicitly assert that no `attendees`, `listing_attendees`,
  `attendee_answers`, newly-created `strings`, audit-trail records, or
  `booking_imports` rows survive a forced late-row failure.
- A product matching a `daily`-type listing imports a dated line
  (`start_at`/`end_at` from `Delivery Date`/`Collection Date`) that appears on
  the **day-calendar** (`getDailyListingAttendeesByDate`) — and on an agent run
  sheet (`getAgentRunSheet`) only **after** an agent is assigned, since the
  importer doesn't assign one; a product matching a `standard`-type listing
  **blocks** the upload (listed on the missing-setup page as must-be-daily) and
  writes nothing.
- A source booking repeating the same matched listing on the **identical** date
  range produces a single quantity-summed line (one row per
  `(attendee, listing)`), proving the planner collapses rather than emitting two
  rows the edit form / per-`(attendee, listing)` actions can't represent. **Any
  non-identical** range for the same listing — adjacent (Jan 1 + Jan 2),
  overlapping, or non-contiguous (Jan 1 + Jan 10) — is **rejected as
  unrepresentable** (reported, not widened — one line's quantity would otherwise
  apply to every day in the widened span, overstating capacity).
- The raw audit-trail fields are persisted to their durable encrypted
  destination (read back after import), not just shown in the report.
- Legacy rows can overbook without failing the import.
- Financial mapping posts each booking's owed/paid legs to the `transfers`
  ledger (`attendee ↔ imported:default`) and stamps each line's
  `ledger_event_group`, but posts **no** `revenue:<listing>` legs — so every
  matched listing's projected income is unchanged (£0 from imports) while the
  attendee's projected owed balance (`−balanceOf(attendee)`) equals the source
  `Balance`. Raw totals are preserved in the encrypted audit trail / report, not
  in dropped columns.
- Raw concatenated/invalid emails are imported without splitting or rejecting
  the row. (Known accepted tradeoff: a later admin edit of such a row is blocked
  by the edit form's `validateEmail` until the operator fixes/clears the email.)
- `Date Booked` is written to `attendees.created`: an imported booking with an
  old source date is ordered by that date (not import time); a
  missing/unparseable `Date Booked` falls back to import time. Both id-ordered
  surfaces now order by `created` — the dashboard `getNewestAttendeesRaw` _and_
  the `/admin/attendees` list/CSV `getAttendeesPage` place an imported old
  booking _below_ a newer real registration, not above it by fresh id.

Free-text question tests (the PR #1335 surface):

- A configured column with a matching `free_text` question creates an
  `attendee_answers` text row (`answer_id` NULL, `question_id` + `string_id`
  set), and `getAttendeeTextAnswers(attendeeId, privateKey)` reads back the
  exact source text.
- A non-empty **required-question** column with **no** matching free-text
  question blocks the import before writes and is listed on the error report; a
  non-empty **audit-only** column with no question does **not** block — its
  value goes to the encrypted audit trail.
- Radio/select questions are **not** treated as import targets even if their
  text matches a CSV header.
- A CSV header matching two `free_text` questions with the same normalized text
  is rejected as ambiguous and writes nothing.
- A matched `free_text` question assigned to none of the booking's listings
  blocks the import (no hidden answer is written).
- Identical answer text across two candidate bookings is deduped into a single
  `strings` row (assert one row / shared `string_id`), resolved once rather than
  via per-attendee saves.
- Strings are created only for candidate rows: an already-imported (skipped) row
  whose answer text appears nowhere else creates no `strings` row.
- At most one text answer per `(attendee, question)`: a booking that would map
  the same question twice with the _same_ value produces exactly one answer row;
  two duplicate columns with _different_ values are rejected as a source-data
  error.
- Imported answers are written using the owner public key only (no unwrapped
  private key required for the write path).

Semantic-correctness tests (verified against live behaviour):

- A multi-booking import wires each attendee's `listing_attendees` /
  `attendee_answers` / `booking_imports` rows to the correct attendee (no
  cross-attachment from `last_insert_rowid()` drift).
- A source `Status` matching two local statuses is rejected as ambiguous; writes
  nothing.
- A cancelled source row imports as an attendee with the `Cancelled` status and
  `quantity = 0` `listing_attendees` lines for its matched products, leaving the
  referenced listings' `booked_quantity` unchanged.
- A quote row (empty `Equipments` with a `Quoted for Products` block) imports
  its interested-in products as `quantity = 0` lines matched to real listings.
- A `Quote`-status row with a **populated** `Equipments` field also imports
  every matched product as `quantity = 0` (non-capacity status — quoted, not
  booked) and posts **no** ledger legs, leaving `booked_quantity` and the ledger
  untouched.
- An imported attendee with only quantity-0 lines is **not** treated as an
  orphan and survives an orphan auto-purge run (its `attendee_answers` and
  `booking_imports` row also survive).
- No-quantity **feature** behaviour — checkbox round-trip, the `tickets_count`
  aggregate change (insert/update/delete + recalc-drift), exclusion from the
  operational/public/marketing surfaces, and the public-form + JSON API guard —
  is covered by the shipped feature's own suite
  (`test/integration/no-quantity-audit.test.ts`, the
  `attendees.no-quantity-tickets` story, the shared-predicate guard tests) and
  not retested here. The importer tests assume that feature and assert imports
  flow through it:
- An imported cancelled/quoted attendee (quantity-0 only) is absent from the
  daily calendar, ICS feed, bulk email, logistics, and ticket/check-in flows,
  yet still shows in the admin per-listing and group-detail rosters with the "no
  quantity" indicator.
- A quantity-0-only (cancelled/quoted) attendee posts **no** ledger legs, so its
  projected owed balance is £0 and it is not publicly payable — its source
  `Balance` recognises nothing. A confirmed import with ≥1 real line posts its
  owed/paid legs, so its outstanding `Balance` projects from the ledger
  (`−balanceOf(attendee)`); settling it posts a real `external:world → attendee`
  leg against the **attendee** account (guarded on the projected owed amount),
  so a _mixed_ attendee needs no lower-id-line targeting at all.
- Imported visit and booking counts: a confirmed (real-quantity) import
  increments the customer's visit counter **and** `admin_booking_count` (assert
  both — an implementation could pass a visits-only test while
  `/admin/history/:hmac` still omits imported bookings); a cancelled/quote-only
  import increments neither; a rolled-back import leaves both untouched.
- **Imported daily hires land on the right operational dates:** an imported
  booking on a daily listing appears on the day-calendar
  (`getDailyListingAttendeesByDate`) at its `Delivery Date` (the line's
  `start_at`); once an agent is assigned it also shows on that agent's run sheet
  (`getAgentRunSheet`) — the importer populates the dates/times but not the
  agent. Confirms the daily-only gate makes per-booking dates work without new
  standard-listing line-date paths.
- **A later-orphaned _zero-money_ import frees its `old_id`:** deleting a
  cancelled/quoted (no-ledger-legs) import's last listing, then running the
  orphan auto-purge, removes the attendee _and_ its `booking_imports` row, so
  re-uploading the same CSV re-creates the booking rather than skipping it. **A
  money-bearing import instead keeps its mapping as a tombstone** (its
  append-only import legs make the `(schema, old_id)` event un-replayable — see
  the cleanup section), so its `old_id` stays mapped and a re-upload skips it;
  assert both.
- **Merging an imported source keeps the import map consistent:**
  `applyAttendeeMerge` on an imported source **remaps** its `booking_imports`
  row to the surviving target — even when the target is itself an import, since
  `new_id` is non-unique, so two `old_id`s then point at the merged attendee. It
  never deletes the source mapping (that would let a re-upload recreate a
  duplicate), so no row points at the removed source id.
- **The admin roster won't check in a quantity-0 line:** a cancelled/quoted row
  stays visible on `/admin/listing/:id` but renders the "no quantity" indicator
  instead of a check-in button, and `handleAttendeeCheckin`/`updateCheckedIn`
  refuse it if invoked directly.
- A non-reservation status with a residual source `Balance` still posts faithful
  owed/paid ledger legs (the outstanding amount projects from the ledger for the
  admin record), but the public pay page does not offer it — payability is gated
  by the resolved status's `is_reservation` flag, unchanged by the import.
- A row with empty `Equipments` and no `Quoted for Products` fallback is
  reported as non-creatable and creates no attendee/import-map row.

## Implementation Phases

These group the work by stream; the numbering is **not** a strict execution
order. The **engine/schema split** (see
[Architecture](#architecture--core-principles), [Schemas](#schemas)) cuts across
them: phases 2–5 and 7 are the generic engine, while the `event_bookings`
`SchemaDefinition` + the schema registry are built alongside phase 3 (they
supply the column mappings, parsers, and resolver config the engine consumes —
no schema literals in the engine). One cross-dependency to call out: the
transactional writer (item 5) emits `quantity = 0` lines, so it depends on the
no-quantity guards — which **shipped as #1366** and are already in main; only
the importer-specific additions in item 6 remain.

1. Schema and import-map helper
   - Add `booking_imports` (migration sequenced after
     `2026-06-20_free_text_questions`).
   - Add narrow helpers to fetch existing old IDs and insert mappings.
   - Point the legacy-notes audit trail at the landed **`system_notes`** owner
     note (`createOwnerNote`, owner-public-key) — report-only is **not** an
     option, it loses data. The durable encrypted destination now exists;
     free-text questions cover the high-value columns, the owner note holds the
     raw remainder.
   - Tests for idempotency helpers.
2. CSV parser and source model
   - Parse row arrays into typed `SourceBooking` values.
   - Preserve duplicate modifier/payment column pairs by index.
   - Preserve raw email strings, including concatenated values.
   - Tests for sample-shaped rows.
3. Product, status, and question setup resolvers
   - Resolve source product names to listing IDs.
   - Resolve source `Status` values to attendee status IDs.
   - Resolve configured columns to `free_text` question IDs (normalized exact
     text, free-text only); reject duplicate-text matches and require the
     question to be assigned to the booking (block, don't warn). Internal
     columns resolve to **staff-only** free-text questions (off the public
     form); this needs the staff-only flag added to the question feature (PR
     #1335).
   - Apply longest-match-first product resolution bounded to whole tokens, and
     no aliases.
   - Gate matched listings to `daily` type: a product matching a `standard`-type
     listing is a blocking setup error (operator must convert it to daily).
   - Missing-setup error route (products + statuses + questions + standard
     listings that must be made daily).
   - Listing-name prefill/lock flow; optional status/question text prefill.
4. Import planner
   - Build a pure import plan from source rows plus existing
     listings/statuses/questions/imports.
   - No database writes from this layer.
   - Produce per-attendee text-answer sets (`{ questionId, text }`) from the
     candidate rows, deduped per booking; flag conflicting duplicate columns.
   - Classify each source row: creatable, skipped (already imported),
     non-creatable (zero products), or blocked (missing/ambiguous setup).
   - Report skipped, creatable, non-creatable, missing setup, warnings, and
     unmapped metadata.
5. Transactional writer
   - **Relies on the no-quantity feature (shipped as #1366).** It writes
     `quantity = 0` lines (cancelled and interested-in/quoted products), which
     depend on the shipped `TICKET_COUNTS_PREDICATE` and reader/writer/action
     guards — all in main, so imported ghost rows stay out of `tickets_count`
     and the token/calendar/email/logistics surfaces. Build the
     importer-specific additions in item 6 alongside the writer.
   - Resolve candidate text answers to string ids **inside the guarded
     transaction** by passing it the `TxScope` `getOrCreateStringIds` accepts,
     so a rolled-back file leaves no `used_count = 0` strings behind.
   - Convert the import plan into attendee / listing_attendee / attendee_answers
     (text) / audit / import-map writes in one guarded transaction, wiring child
     rows to each attendee via its generated `ticket_token_index`, not
     `last_insert_rowid()`.
   - Write status ids, free-text answers, and logistics times. Record money by
     posting each booking's owed/paid legs to the `transfers` ledger
     (`attendee ↔ imported:default`, only for candidates with ≥1 real line) and
     stamping each line's `ledger_event_group` — no
     `remaining_balance`/`price_paid` columns to set, and no `revenue:<listing>`
     legs (listings stay at £0 from imports).
   - Write cancelled rows and interested-in/quoted products as `quantity = 0`
     lines (never zero lines); confirmed `Equipments` products get real
     quantities.
   - Increment `visits` and `admin_booking_count` for candidates with ≥1 real
     (`quantity > 0`) line only (the writer bypasses `createAttendeeAtomic` and
     its contact activity), using the source `Date Booked` with
     `last_activity = MAX(existing, source)` (see step 14), within the rollback
     boundary.
   - Allow overbooked legacy rows (active bookings only; quantity-0 lines don't
     count toward capacity).
   - Prove whole-file rollback (attendees, lines, text answers, new strings,
     audit records, visit counts, import map all gone).
6. No-quantity feature (**shipped as PR #1366** — consume it)
   - The importer writes `quantity = 0` lines; the whole no-quantity feature is
     **already in main**: the `tickets_count` aggregate change (shared
     `TICKET_COUNTS_PREDICATE = "quantity > 0 AND kind = 'attendee'"` + guard
     test + migration), the owner "no quantity" checkbox and save path (forbid
     converting a line with money recognised against it in the ledger), the full
     reader/writer/action audit, and the public form + JSON API guard. All of
     that — and its tests — lives in main; don't restate it here.
   - Importer-specific work that remains (NOT part of the shipped no-quantity
     work):
     - Add a **staff-only / import-only flag** to free-text questions (a PR
       #1335 addition) so import-only legacy columns render on the admin edit
       form but never on the public path (incl. QR direct-checkout gating);
       assignment is still required so answers aren't dropped on save.
     - Re-order the two id-ordered attendee surfaces by `created` (with `id`
       tiebreaker, composite `(created, id)` index): the dashboard
       `getNewestAttendeesRaw` and the `/admin/attendees` browser + CSV
       `getAttendeesPage`, so imports' fresh ids don't dominate "newest".
     - `booking_imports`: drop the unique `new_id` index; clean up conditionally
       — orphan purge and `deleteAttendee` with `releaseBookings: true` delete
       the mapping; a held delete (`releaseBookings: false`) on these
       **daily-only** rows frees/remaps the mapping **only when the aggregate
       contribution is genuinely released** — the current held-delete path
       _restores_ `booked_quantity`/`tickets_count`, and freeing the id in that
       state would let a re-upload double-count on top of the restored
       aggregate; if hold-and-restore is kept, the mapping stays a tombstone
       (see the daily held-delete caveat and the two-axis rule in the cleanup
       section); and `applyAttendeeMerge` remaps source→target (the non-unique
       `new_id` allows it). Merge must also reverse a _discarded conflicting_
       imported booking's `import_owed`/`import_paid` legs (decision 17 only
       un-bills `sale` legs, which imports don't post — see the merge note).
       Free-text (`string_id`) answer adoption is **already done by main**; the
       importer only adds a test for it.
     - Tests: imports order by `created` (not fresh id); a staff-only question
       renders on admin edit but not the public form; merging an imported source
       remaps its `booking_imports` row and preserves its free-text answers;
       merging two imported attendees with a _conflicting_ booking and
       discarding one leaves the target's owed balance counted **once** (the
       discarded booking's `import_owed`/`import_paid` legs are reversed, not
       double-counted by the repoint); a held delete of a **zero-money** daily
       import frees/remaps the mapping **only on the aggregate-released branch**
       (the dated row is gone _and_ the aggregate contribution was genuinely
       released — if the hold-and-restore path kept the aggregate, assert the
       mapping stays a tombstone instead, or a re-upload double-counts on top of
       the restored aggregate) and an orphan/released delete of a **zero-money**
       import frees the `old_id` — while a **money-bearing** import keeps its
       mapping as a tombstone in every delete flow (its import legs make the
       `(schema, old_id)` event un-replayable; see the cleanup section's
       two-axis rule).

7. Admin upload route
   - Wire upload form, parser, planner, writer, success/error redirects.
   - Add nav entry if desired.
8. Full coverage and precommit
   - Route tests, DB tests, parser tests, and coverage closure.

## Resolved Decisions

- The importer is a **generic, schema-driven engine**; `event_bookings` is the
  first schema and the operator picks it from a list on upload. Engine code
  carries no schema literals — future formats add a `SchemaDefinition`, not
  engine changes.
- The core pipeline (parse → resolve → validate → plan) is **pure/functional** —
  no DB writes outside the final guarded transaction — so it is testable and the
  schema config is swappable.
- **Exhaustive preflight, one report:** everything checkable is verified before
  any write, and every problem (missing setup, ambiguity, source-data,
  non-creatable, unrepresentable, invalid fields) is accumulated and shown at
  once — never stop-at-first-error. The write runs only when there are **no
  blocking errors** — reported skips/warnings (already-imported, non-creatable)
  don't block the valid rows.
- Source `Status` drives attendee status. `Colour Name` is legacy metadata.
- Missing source statuses block the upload before writes, like missing products.
  A source status matching more than one local status (names aren't unique) is
  an ambiguous-setup error, not a silent pick.
- Rows whose source `Status` is schema-declared **non-capacity**
  (`event_bookings`: `Cancelled` and `Quote` — including a quote-status row's
  populated `Equipments`), and interested-in/quoted products parsed from notes,
  import as `listing_attendees` lines with `quantity = 0` (not omitted), leaving
  a real, matched line that keeps the attendee from being auto-purged as an
  orphan. Confirmed `Equipments` products on capacity statuses get real
  quantities.
- A blank `Customer Name` is a **blocking source-data error** (row + column in
  the report): the edit form requires `name` on every save, so importing blank
  defers the failure to the first edit, and inventing a placeholder would guess.
  Owners see/edit this as a per-line "no quantity" checkbox (a proxy for
  `quantity == 0`, quantity input hidden by CSS); the save path keeps deliberate
  quantity-0 lines and only deletes on an explicit removal. (Alternative
  rejected: omitting lines for cancelled rows — they'd be purged as orphans
  while `booking_imports.old_id` blocks re-import.)
- A quantity-0 line counts toward **neither** capacity (`booked_quantity`,
  `SUM(quantity)`) **nor** `tickets_count`. `tickets_count` already counts only
  real-ticket rows via the shipped shared `TICKET_COUNTS_PREDICATE`
  (`quantity > 0 AND kind = 'attendee'` — it also excludes servicing-kind rows)
  at every site (triggers, reset/recalc SQL, schema-sync backfill), guarded
  against drift by a test. The importer only writes `kind = 'attendee'` rows, so
  its quantity-0 lines land outside `tickets_count` exactly as intended. Listing
  `income` is unaffected: it projects from `revenue:<listing>` ledger legs, and
  a quantity-0 ghost line posts none (the importer posts no `revenue` legs at
  all).
- Quantity-0 is admin/importer-only; the public booking/checkout path must never
  create a quantity-0 line.
- Legacy imports may overbook — for _active_ bookings only; quantity-0 lines
  (cancelled/interested) never count toward capacity.
- A booking's money posts to the `transfers` ledger, not to columns. Owed/paid
  legs are posted **only for bookings with ≥1 real (`quantity > 0`) line**, so a
  quantity-0-only cancelled/quoted import posts nothing — its owed balance
  projects as £0 and it is never publicly payable. The outstanding balance
  projects as `−balanceOf(attendee)`; public payability is gated by the resolved
  status's `is_reservation` flag at the pay page (unchanged) — there is no
  `remaining_balance` column to gate. Settlement posts a real
  `external:world → attendee` payment leg against the **attendee** account,
  guarded on the projected owed amount, so a _mixed_ attendee needs no
  lowest-id-line targeting — the old `settleAttendeeBalance` `MIN(id)`
  income-fold disappeared with `price_paid`.
- Quantity-0 (cancelled/quoted) imports are excluded from operational, public,
  and marketing surfaces but kept in admin record/detail views (with the "no
  quantity" indicator, per-row actions guarded). The full surface-by-surface
  audit shipped with the no-quantity feature (#1366) and lives in its code and
  tests; it is not duplicated here.
- The writer records **both** the visit count **and** the source booking count
  for confirmed (real-quantity) imported bookings only, since it bypasses
  `createAttendeeAtomic` contact activity. A live booking bumps `visits` **and**
  the matching `admin_booking_count`/`public_booking_count`, so incrementing
  only `visits` would leave imported customers looking like first-time visitors
  for visit-gated modifiers **and** leave `/admin/history/:hmac` booking counts
  omitting imported bookings. The importer must bump the
  **`admin_booking_count`** column too (imports are admin-initiated), not just
  `visits`. It must **not** reuse the live booking statements as-is (they stamp
  `last_activity = nowMs()`); increment both counters with the source
  `Date Booked` and `last_activity = MAX(existing.last_activity, source)` so old
  imports don't look freshly active to pruning, all within the rollback
  boundary.
- The importer fires **no registration side-effects**: it never calls
  `logAndNotifyRegistration`, so a bulk historical upload sends no customer
  emails, no registration webhooks, and triggers no built-site
  assignment/renewal. It writes rows directly and stays silent.
- A row with **no** products at all (no `Equipments` and no parseable quoted
  block) is a reported non-creatable row: not written, not added to the import
  map. Every booking needs ≥1 line, even if quantity-0.
- Two CSV columns mapping to the same free-text question with different
  non-empty values are an ambiguous source-data error (the schema stores one
  answer per `(attendee, question)`); identical values collapse to one.
- Imported financial totals do not affect listing income: the importer posts no
  `revenue:<listing>` legs, so every matched listing stays at £0 from imports,
  and there is no `price_paid` column — per-listing amount-paid projects from
  the ledger as £0. Imported money lands only on the
  `attendee`/`imported:default` accounts.
- Raw emails are imported as source data, including concatenated or invalid
  values, stored as-is inside the attendee's **encrypted `pii_blob`** (via
  `buildPiiBlob`) — there is no `attendees.email` column, and the importer must
  **not** add a cleartext one. Accepted tradeoff: once the value is decrypted
  for editing, the attendee edit form (`type="email"` + `validateEmail` on POST)
  blocks the first admin re-save of such a row until the operator fixes/clears
  the email; the importer does not relax the edit path or relocate the raw
  value.
- `Equipments` is authoritative when populated. Notes/modifiers do not add
  products to populated `Equipments` rows.
- There is no product/status/question alias mechanism. Matching is normalized
  exact matching, with longest-match-first product scanning for names containing
  slashes — but matches must span whole source tokens, never substrings.
- Product/status/question matching never guesses. A header that matches more
  than one `free_text` question (duplicate text is allowed by the schema) is an
  ambiguous-setup error, not a silent pick.
- Legacy free-text columns are imported as **free-text question answers** (PR
  #1335): the operator creates `free_text` questions whose text matches the CSV
  headers; the importer stores source values as owner-key-encrypted,
  deduplicated `strings` referenced from `attendee_answers`. Missing required
  free-text questions, and matched questions not assigned to the booking, block
  the upload before writes, like missing products and statuses. Internal columns
  (e.g. `Colour Name`, invoice fields) are created as **staff-only** free-text
  questions — a required addition to PR #1335 — so they render on the admin edit
  form but never on the public booking form (assigning a normal question would
  expose it publicly).
- The importer reuses PR #1335's `strings`/`attendee_answers` schema and helpers
  and does not redefine them; it adds **two** tables of its own —
  `booking_imports` and the short-lived missing-setup stash (see Data Model).
- All-or-nothing means all-or-nothing: a rolled-back import leaves **no** new
  rows, including `strings` rows created for text answers. String upserts are
  unwound on failure rather than left as orphaned encrypted PII, and text
  strings are collected from candidate rows only (not skipped/non-creatable
  rows).
- Child rows are wired to each attendee via its generated `ticket_token_index`
  (the pattern in `attendees/create.ts`), never `last_insert_rowid()`, which
  drifts across a multi-row batch.
- The raw audit trail has its durable encrypted destination: the per-attendee
  `system_notes` **owner** note (`createOwnerNote`, owner-public-key), landed
  with the notes rework. The import report is not a system of record; an import
  that would otherwise drop unmapped audit fields must block, never lose data.
- Marking a line "no quantity" (`quantity = 0`) is **forbidden on a paid line**
  — one with money recognised against it in the ledger (its
  `ledger_event_group`'s per-listing amount-paid projects `> 0`): refund or
  retarget the charge first. Don't silently detach the line from its ledger legs
  — that drops income **and** strands the charge, since the quantity-0 refund
  guards then hide/refuse the row (the shipped save-path guard:
  `isPaymentLockedLine` + `validatePaidNoQuantity` + the server-side
  `hasPaidLine` re-check). Only a line with no money recognised against it (e.g.
  an imported cancelled/quoted ghost line, which posts no legs) may become
  no-quantity.
  - **Imported-money caveat (importer-specific guard extension).** The shipped
    paid-line guard measures amount-paid via `pricePaidFromLedger`, which sums
    only **`sale` legs** — it is **blind** to the importer's
    `import_owed`/`import_paid` legs (posted to `imported:default`, not
    `revenue`). So a **fully-paid** imported booking (`Total = Received` →
    projected owed £0 **and** projected per-listing paid £0) is invisible to
    both the paid-line guard and the no-real-line owed-reversal, so the
    checkbox/merge path could ghost its last real line and strand the
    `import_owed`/`import_paid` legs on an all-ghost attendee. Before the
    importer is enabled, extend the no-quantity ghosting guard — **and implement
    the merge writer's whole-result owed-leg reversal, which the shipped feature
    still lacks** (the edit path reconciles a no-real-lines attendee's owed
    balance to £0 with a `writeoff` leg; `applyAttendeeMerge` has no equivalent
    step) — to also detect a line whose `ledger_event_group` carries **import**
    legs and block/reverse them, not just `sale` legs.
- The importer **only imports products that match `daily`-type listings**; a
  product matching a `standard`-type listing is a blocking setup error. An
  _empty, ungrouped_ standard listing can be converted to daily in place, but
  conversion is blocked as unresolvable when the listing is **populated**
  (undated rows would drop off the daily calendar/capacity) or in a **group with
  any siblings** (`validateGroupListingType` forbids a single in-place type
  change regardless of sibling bookings — and with multi-group membership it
  must be removed from every such group first); never auto-convert. Gating to
  daily keeps every imported line inherently dated — the daily listing carries
  the `Delivery`/`Collection` range on `start_at`/`end_at`, so the
  **day-calendar** (`getDailyListingAttendeesByDate`) works out of the box. (Run
  sheets need an agent: `getAgentRunSheet` matches on
  `start_agent_id`/`end_agent_id`, which the importer doesn't set, so imported
  lines reach a run sheet only after an admin assigns an agent — see Dates.)
  Chosen over dating standard lines, which would force new line-date paths
  through the calendar, the ICS feed, and the edit form.
- `Date Booked` maps to `attendees.created` so admin "newest" views and
  calendar/list/CSV exports order imports by their original booking date, not
  import time; fall back to import time only when `Date Booked` is
  missing/unparseable. The two id-ordered surfaces are switched to order by
  `created` (with `id` as a deterministic tiebreaker, backed by a composite
  `(created, id)` index): the dashboard `getNewestAttendeesRaw` and the
  `/admin/attendees` browser + CSV `getAttendeesPage` — otherwise imports' fresh
  ids would make them dominate those "newest" views despite old `created`.
- Per-booking line dedup happens in the planner: there is **one line per
  `(attendee, listing)`**. Only **identical** date ranges may be summed (a
  single line applies one quantity across its whole interval); **any** differing
  range — adjacent, overlapping, or non-contiguous — is **rejected as
  unrepresentable**, never widened (widening overstates capacity on every
  covered day). The edit form de-dupes by `listing_id` and
  per-`(attendee, listing)` action helpers can't represent multiple lines per
  listing, and the unique `(listing_id, attendee_id, start_at)` index would
  reject duplicate dated rows anyway — so the planner must collapse, not rely on
  the constraint.
- `booking_imports.new_id` is **not unique** — after a merge, several source ids
  can map to one surviving attendee. Idempotency keys on the composite
  `(schema, old_id)` (a unique index), which also namespaces source ids across
  schemas so a future format's reused id can't collide.
- `booking_imports` cleanup is conditional on capacity actually being released:
  the orphan auto-purge and `deleteAttendee` with `releaseBookings: true` delete
  the mapping (free the `old_id`); a **held** delete (`releaseBookings: false`)
  keeps the mapping as a tombstone **only for aggregate-held standard listings**
  — but imports are **daily-only**, where a held delete removes the dated row
  the calendar/capacity read, so it should free/remap instead (see the daily
  held-delete caveat) rather than stranding a re-import forever. **Conditional
  on actually releasing the aggregate:** the current held-delete path _restores_
  `booked_quantity`/`tickets_count` after deleting the rows
  (`ATTENDEE_LISTING_CONTRIBUTIONS_SQL`), and a re-upload of a freed `old_id`
  inserts new rows whose triggers add quantity **on top of** that restored
  aggregate — double-counting. So free/remap only when the daily import's
  aggregate contribution is genuinely released (skip the restore for these rows,
  or release it as part of the cleanup); if the hold-and-restore behaviour is
  kept, the mapping must stay a tombstone. `applyAttendeeMerge` **remaps** the
  source's mapping to the target (never drops it), which the non-unique `new_id`
  now allows.
- Attendee merge **adopting free-text (`string_id`) answers** is **already
  handled by main** (`applyAttendeeMerge` merges both attendees' text answers
  onto the target with target-precedence); the importer just needs a test that
  an imported source's legacy text answers survive a merge.
- Attendee merge must **reverse a discarded conflicting imported booking's
  `import_owed`/`import_paid` legs**. Decision 17 only un-bills `sale` legs
  (which imports don't post), but the wholesale ledger repoint still carries the
  discarded booking's owed/paid legs onto the target — so without this, two
  conflicting imported bookings double-count the owed balance (see the merge
  note).
