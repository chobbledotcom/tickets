# Booking CSV Importer Plan

## Goal

Build an admin-only importer that accepts `bookings.csv`-style exports and
creates bookings in this system.

The importer must be idempotent and all-or-nothing:

- A CSV upload either creates every unimported booking it can create, or creates
  none of them.
- Source bookings already recorded in the import map are skipped.
- The importer never creates products/listings, attendee statuses, or custom
  questions. It only matches imported product names to existing listings, source
  status names to existing attendee statuses, and custom-question columns to
  existing free-text questions.
- If any unimported row mentions a product, status, or required question that
  does not exist locally, no booking is created. The user is sent to an error
  page listing the missing setup.
- Each missing-product link goes to the existing new-listing form with the
  product name pre-filled and not editable. The user can create every required
  listing, upload the CSV again, and continue.
- Missing statuses and missing free-text questions are handled the same way
  conceptually: the operator must create statuses whose names match the source
  `Status` values, and free-text questions whose text matches the CSV column
  headers, then upload the CSV again.
- Legacy imports may overbook. Capacity warnings can be reported, but capacity
  does not block the import.

## In-Progress PR Context (read first)

This revision of the plan is written against the in-progress branches for this
repo. Two of them change the ground the importer stands on:

- **PR #1335 — "Add free-text custom questions with encrypted string storage and
  answer plumbing"** (the "free text question answers" feature). This is now a
  hard dependency: the importer builds directly on the schema and helpers it
  adds, and **must not** reintroduce any of them. The whole "Custom Questions"
  story below is rewritten around its concrete API. See
  [Free-Text Questions Dependency](#free-text-questions-dependency).
- **PRs #1332 / #1333 — contact/attendee notes rework.** These move operator
  notes off the attendee form and into per-contact, owner-key-encrypted records
  keyed by an email/phone HMAC (`GET`/`POST /admin/history/:hmac`), and
  **remove** the per-attendee admin-note textareas. The original plan assumed it
  would add a single per-attendee `notes` column as the home for all legacy
  metadata. That assumption no longer holds; see
  [Where Legacy Metadata Goes](#where-legacy-metadata-goes) for how the importer
  reconciles with this. Land order between #1332 and #1333 is not yet decided,
  so the plan depends only on the *shape* they agree on (encrypted per-contact
  records), not on a specific column.

The other open PRs (#1330 scheduled tasks, #1331 recalculate table, #1334
balance N+1, #1336 delivery dates, #1337 modifier batching, #1338 test browser)
do not interact with the importer and are not dependencies.

## Free-Text Questions Dependency

PR #1335 is the mechanism the importer uses for every legacy free-text column
(`Surface`, `Age Group`, the party questions, exhibition stand number, etc.).
The plan previously hedged this as "once the custom question system supports
text answers" — that system now exists, so the hedging is replaced with the real
contract.

What #1335 provides, and the importer reuses verbatim:

- **`display_type` gains `"free_text"`.** `QUESTION_DISPLAY_TYPES` is now
  `["radio", "select", "free_text"]`. A free-text question has **no answer
  rows** — `withAnswers` was changed to keep `free_text` questions even though
  their `answers` array is empty. So a free-text question is identified purely by
  `display_type === "free_text"` and its decrypted `text`.
- **`strings` table** — a deduplicated, owner-key-encrypted text repository:
  `(id, text_index TEXT UNIQUE, encrypted_text, used_count)`.
  - `text_index = hmacHash(text)` (deterministic HMAC; the unique index is what
    makes dedup work).
  - `encrypted_text = encryptWithOwnerKey(text, settings.publicKey)` — hybrid
    encryption against the **owner public key**, *not* the symmetric
    `DB_ENCRYPTION_KEY`.
  - `used_count` is trigger-maintained from `attendee_answers`, and a string row
    is auto-deleted when `used_count` drops to `<= 0`.
- **`attendee_answers` shape change.** `answer_id` is now nullable; new
  `question_id` (now required on **every** row) and `string_id` columns. BEFORE
  triggers enforce a strict XOR per row:
  - choice answer: `answer_id` set, `question_id` set, `string_id` NULL;
  - text answer: `answer_id` NULL, `question_id` set, `string_id` set.
  A new unique index `(attendee_id, question_id)` means **at most one free-text
  answer per question per attendee**.
- **Helpers** (all in `src/shared/db/questions.ts`):
  - `getOrCreateStringIds(texts: string[]): Promise<Map<string, number>>` —
    dedupes, encrypts each unique text with the owner public key, `INSERT OR
    IGNORE`s into `strings`, and returns a `text → stringId` map.
  - `saveAttendeeAnswers(Map<number, number[] | AttendeeAnswerSet>)` where
    `AttendeeAnswerSet = { answerIds: number[]; textAnswerIds?: TextAnswerId[];
    textAnswers?: TextAnswer[] }`,
    `TextAnswer = { questionId; text }`, `TextAnswerId = { questionId; stringId }`.
    Passing `textAnswers` lets the caller hand over raw source text and have the
    string created/looked-up for it.
  - `getAttendeeTextAnswers(attendeeId, privateKey): Promise<Map<number, string>>`
    — reads answers back, decrypting with the owner **private** key.

Two consequences that drive importer design:

1. **Writing free-text answers needs only the owner public key** (via
   `settings.publicKey`), exactly like the public checkout path. The importer is
   admin-authenticated, but it does not need the unwrapped private key to *write*
   imported answers. Reading them back (e.g. in tests, or the attendee edit form)
   does need the private key.
2. **`getOrCreateStringIds` writes `strings` rows in its own batch**, separately
   from any `attendee_answers` insert. The importer's whole-file transaction must
   account for this — see
   [All-Or-Nothing Write Strategy](#all-or-nothing-write-strategy).

## Current CSV Shape

Observed from the checked-in `bookings.csv`:

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
      ["old_id", "TEXT PRIMARY KEY"],
      ["new_id", "INTEGER NOT NULL"],
    ],
    indexes: [
      { name: "idx_booking_imports_new_id", columns: ["new_id"], unique: true },
    ],
  },
]
```

- `old_id` is the source `Booking ID` from the CSV.
- `new_id` is the created `attendees.id`.
- No separate import-run table for the first pass. The user asked for only old
  id and new id, and idempotency does not require run metadata.
- Add the table to the declarative schema and a migration. Keep the schema
  update narrow and follow the existing migration pattern.

The importer does **not** add the `strings` table or the `attendee_answers`
`question_id`/`string_id` columns — those arrive with PR #1335's migration
`2026-06-20_free_text_questions`. `booking_imports` is the only new table the
importer introduces. Sequence the importer's migration after the free-text one.

Attendee notes / legacy metadata storage:

- The original plan added a per-attendee encrypted `notes` column as the single
  home for `Customer Notes`, `Operator Notes`, payment metadata, etc. PRs
  #1332/#1333 are concurrently reworking where operator notes live (per-contact
  encrypted records keyed by email/phone HMAC, edited at `/admin/history/:hmac`,
  with the per-attendee note textareas removed). **Do not** add a competing
  per-attendee `notes` column without reconciling with whichever of those lands.
- Net effect on this plan: lean on **free-text questions** for the legacy text we
  actually want surfaced and searchable per booking (see
  [Custom Questions](#custom-questions)), and treat the raw audit-trail dump as a
  smaller, secondary concern whose destination is decided once the notes rework
  settles. Keep `special_instructions` for customer-facing booking instructions.
- If, when the importer is built, no suitable notes destination exists yet, the
  importer should still preserve the raw legacy fields somewhere encrypted (a
  labelled block on the per-contact record, or a minimal attendee `notes` column
  added in agreement with the notes-rework work) — but free-text questions cover
  the high-value columns either way, so this is no longer a blocking prerequisite
  for a first importer pass.

## Proposed Routes And UI

Add admin routes:

- `GET /admin/imports/bookings`
  - Upload form for the CSV.
  - Optional short instructions and a link to existing listings/questions.
- `POST /admin/imports/bookings`
  - Authenticated multipart upload.
  - Parses, validates, resolves products/statuses/questions, and runs the import
    transaction.
  - Redirects to success with created/skipped counts.
- `GET /admin/imports/bookings/missing`
  - Error page populated from repeated `product`, `status`, and `question` query
    params.
  - Example:
    `/admin/imports/bookings/missing?product=Foo&product=Bar&status=Cancelled&question=Surface`
  - Renders one link per missing product:
    `/admin/listing/new?import_name=Foo`
  - Renders missing statuses with the exact source name and a link to
    `/admin/settings/statuses/new`.
  - Renders missing questions with the exact required header text and a link to
    `/admin/questions`, telling the operator to create a **free-text** question
    with that exact text. If adding a name/text prefill is cheap, mirror the
    listing `import_name` flow for statuses and questions too (e.g.
    `/admin/questions?import_text=Surface` pre-filling the question text and
    defaulting `display_type` to `free_text`).

Extend listing creation:

- `GET /admin/listing/new?import_name=...`
  - Pre-fill the listing name.
  - Render the name as readonly.
  - Keep all normal listing fields available, because the importer cannot infer
    capacity, pricing, daily-vs-standard behavior, images, groups, etc.
- `POST /admin/listing?import_name=...`
  - Treat `import_name` as the source of truth for `name`, not the submitted
    form value.
  - The readonly HTML is for the user experience; the server must still enforce
    the locked name.

If the missing-setup URL becomes too long in real uploads, replace the query
param list with a short-lived server-side error stash later. For the first pass,
use the query-param shape the workflow calls for.

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

Required columns for MVP:

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

1. Use `Equipments` as authoritative when it is populated.
2. If `Equipments` is empty, parse `Operator Notes` blocks of the form
   `Quoted for Products: -- Product A -- Product B -- Products (xN) ...` as a
   fallback and report that fallback in the import summary.
3. Never use `Operator Notes`, modifier columns, or payment columns to add extra
   required products when `Equipments` is populated. Preserve those fields as
   free-text answers / notes instead.
4. Dedupe product names within a booking and convert duplicates to quantity
   only when we are confident they are repeated whole products.

Important caveat: the export uses ` / ` as a product separator, but some product
names appear to contain slashes, for example names like
`Rodeo Bull / Bucking Bronco`. A naive split will create false missing products.

Product matching:

- Normalize for matching by trimming and collapsing whitespace.
- Start with case-insensitive exact matching after normalization.
- Match known listing names longest first over the raw `Equipments` text before
  splitting on separators. This lets a local listing named
  `Rodeo Bull / Bucking Bronco` win before the slash is considered a separator.
- After consuming longest matches, split only the remaining unmatched text on
  known separators and report unresolved fragments as missing products.
- Preserve the original source spelling in missing-product errors.
- Do not silently fuzzy-match. If there is ambiguity, fail validation and show a
  row-level error.
- Do not add an alias mechanism. If source and local names differ, the operator
  must set up listings with matching names or fix the CSV before importing.

Because listing names are encrypted at rest, the resolver will probably need to
load and decrypt existing listing names through an application helper rather
than doing a SQL name lookup. Keep the query narrow if adding a dedicated helper.

## Booking Mapping

One source booking should become one `attendees` row with one or more
`listing_attendees` rows.

Suggested field mapping:

| CSV field | Target | Notes |
| --- | --- | --- |
| `Booking ID` | `booking_imports.old_id` | Required, unique per CSV. |
| created attendee id | `booking_imports.new_id` | Write only after attendee creation succeeds. |
| `Customer Name` | attendee `name` | If blank, decide whether to reject or use `Imported booking {id}`. |
| `Email` | attendee `email` | Import the raw source value, including invalid or concatenated emails. Add importer-specific support so these rows do not get rejected or split. |
| `Mobile`, `Telephone` | attendee `phone` | Prefer mobile; append alternate phone to a free-text answer / notes if both exist. |
| delivery address fields | attendee `address` | More useful for hire/logistics than contact address. |
| contact address fields | free-text answer / notes | No second structured address field exists. |
| `Customer Notes`, `Operator Notes` | free-text answers (preferred) and/or per-contact notes | See [Where Legacy Metadata Goes](#where-legacy-metadata-goes). |
| `Delivery Date`, `Collection Date` | booking `date`, `durationDays` | Only meaningful for daily listings. |
| `Drop Off`, `Collection` | `listing_attendees.start_time`, `end_time` | Requires importer-specific write/update; current create helper does not accept these. |
| `Total`, `Received`, `Balance` | price/balance fields | See financial mapping below. |
| `Status` | attendee `status_id` | Resolve source status by existing attendee status name. See status mapping below. |
| `Colour Name` | free-text answer / notes | Preserve as legacy metadata; do not use for status resolution. |
| custom question columns | `attendee_answers` text answers | Match each header to an existing `free_text` question by normalized exact text; store the source value as a string answer. See [Custom Questions](#custom-questions). |

Daily vs standard listings:

- If the matched listing is `daily`, store `date` from `Delivery Date` and
  `durationDays` as the day span through `Collection Date`.
- If the matched listing is `standard`, create an undated booking line and add a
  warning to the import report, because the CSV has booking dates but the
  target listing cannot use them for capacity.
- Duration should be at least 1 day. Same-day delivery/collection is 1 day.

Quantity:

- If the same matched listing appears multiple times in one source booking, use
  a single line with `quantity` equal to the count.
- Do not create duplicate `(listing_id, attendee_id, start_at)` rows; the
  existing unique index would reject them.

## Financial Mapping

The CSV has order-level totals and many modifier/payment columns. The current
system has:

- `listing_attendees.price_paid`, used by listing income aggregates.
- `attendees.remaining_balance`, used by the reservation/balance flow.
- encrypted `payment_id` in the attendee PII blob.
- no order-level ledger and no imported payment-history table.

MVP recommendation:

- Store `Balance` as `attendees.remaining_balance` in minor units.
- Store `0` on every `listing_attendees.price_paid` line. Imported financial
  totals must not affect trigger-maintained listing income.
- Preserve raw `Total`, `Received`, `Balance`, payment columns, and modifier
  columns as free-text answers and/or in the import report (and, for the raw
  audit trail, wherever the notes rework lands).
- Do not allocate `Received` across products in the first importer. Historical
  order totals are source metadata, not listing income.

Do not create rows in `processed_payments` for historical CSV payments. That
table is for provider idempotency, not an accounting ledger.

## Status Mapping

Use the source `Status` column.

- Load existing `attendee_statuses` and resolve each non-skipped source row's
  `Status` value to an existing status by normalized exact name.
- Use the resolved status id when creating the attendee.
- If any source `Status` value is missing locally, block the whole upload before
  writes, list the missing statuses, and ask the operator to create matching
  statuses before retrying.
- Import cancelled rows too. A source row with `Status` = `Cancelled` becomes an
  attendee with the matching local `Cancelled` status.
- Preserve `Colour Name` as a free-text answer / in the import report, but do not
  use it for status resolution.
- Do not add status aliases or fuzzy matching. The operator is responsible for
  setting up local statuses with matching names.

## Custom Questions

This section replaces the old "Custom Questions And Import Notes" plan now that
free-text questions exist (PR #1335). Use free-text custom questions as the home
for every legacy column we want surfaced per booking.

Setup contract (operator's responsibility, mirrors products/statuses):

- For each CSV column the operator wants imported, they create a question whose
  `display_type` is `free_text` and whose text matches the CSV header exactly
  (after normalization). The create form is `POST /admin/questions` with `text`
  and `display_type` fields.
- The question should be `assign_all`, or assigned to at least one listing the
  booking matched, so the imported answer actually renders on the attendee edit
  form. If a matched free-text question is assigned to none of the booking's
  listings, warn (the answer is still stored against the attendee, but it won't
  show in the per-listing UI).

Resolution (pure, before any writes):

- Decrypt existing question text and build a normalized-exact lookup of
  `free_text` questions only. Radio/select questions are not import targets.
- For each configured/importable column with a non-empty value, look up the
  matching free-text question. Normalize and **trim** the value (the public path
  trims free-text answers via `parseFreeTextAnswer`; match that so dedup keys
  line up).
- If a non-empty importable column has no matching free-text question, block the
  upload before writes and list the missing question text on the missing-setup
  page (link to `/admin/questions`).
- Dedupe per booking: at most one text answer per `(attendee, question)` — the
  schema's unique `(attendee_id, question_id)` index enforces this, so the
  planner must not emit two answers for the same question on one booking.

Writing (in the whole-file transaction — see
[All-Or-Nothing Write Strategy](#all-or-nothing-write-strategy)):

- Collect every distinct trimmed answer text across the whole file and call
  `getOrCreateStringIds(allTexts)` **once** to get a `text → stringId` map. This
  dedupes identical answers across bookings into a single encrypted `strings`
  row (e.g. 200 bookings answering `Grass` to `Surface` share one row), and uses
  only the owner public key.
- Emit `INSERT ... attendee_answers (attendee_id, question_id, string_id)` rows
  into the importer's single batch, using the resolved `stringId` and the
  matched `question_id`. Do **not** call the per-attendee `saveAttendeeAnswers`
  helper in a loop — it issues its own `DELETE`/`executeBatch` per attendee and
  would break whole-file atomicity (it is the answer-equivalent of the existing
  "don't call `createAttendeeAtomic` per row" rule). `getOrCreateStringIds`
  followed by direct `attendee_answers` inserts mirrors what `ticket-submit`
  does on the paid path.
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
phone, invoice fields (`Invoice ID`, `Invoice Reference`, `Invoice Date`). They
remain optional — only columns with a matching free-text question are imported as
answers; everything else is left for the audit trail.

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

   Keep this idea, but its **home is unresolved** until PRs #1332/#1333 settle
   (they remove the per-attendee note textareas and move notes to per-contact
   encrypted records). Treat the destination as a small follow-up decision, not a
   blocker: the high-value columns are already covered by (1), and the import
   report can carry the rest in the meantime.

Do not add a product/status/question alias mechanism. Matching is normalized
exact matching everywhere.

## All-Or-Nothing Write Strategy

Do not call `createAttendeeAtomic` once per CSV row and consider the whole file
atomic. That helper is atomic per attendee/order, not across an entire upload.
The same warning applies to `saveAttendeeAnswers` — do not call it per attendee.

Target algorithm:

1. Parse CSV into indexed rows.
2. Validate required columns and row shape.
3. Reject duplicate `Booking ID` values within the uploaded CSV.
4. Query `booking_imports` for all source IDs from the file.
5. Remove already-imported rows from the candidate set.
6. Resolve products for the remaining rows.
7. Resolve source `Status` values to existing attendee statuses.
8. Resolve configured text custom-question columns to existing `free_text`
   questions by normalized exact text.
9. If any products, statuses, or required question mappings are missing,
   redirect to the missing-setup page with repeated query params. No writes have
   happened.
10. Validate dates, quantities, money, and required raw fields.
11. Do not preflight capacity. Legacy imports may overbook.
12. Encrypt attendee PII blobs for every new candidate.
13. Resolve free-text answers: collect every distinct trimmed answer text across
    the whole file and call `getOrCreateStringIds(allTexts)` once to get a
    `text → stringId` map (owner-public-key encryption; dedupes across bookings).
14. Run one write transaction for all new candidates:
    - insert attendee;
    - insert each `listing_attendees` line;
    - write logistics times if used;
    - insert `attendee_answers(attendee_id, question_id, string_id)` text-answer
      rows using the resolved string ids;
    - insert `booking_imports(old_id, new_id)`.
15. If any insert fails, the transaction rolls back and no import-map rows are
    written.

Implementation notes:

- `executeBatchWithResults` runs one libsql batch transaction, but guarded
  inserts can fail by affecting zero rows rather than throwing. The importer
  should bypass capacity guards for legacy rows, and still needs either:
  - a transaction helper that can inspect each statement result before commit
    and throw to roll back, or
  - batch statements that deliberately abort the transaction when any expected
    insert did not happen.
- **`strings` rows are created outside the whole-file transaction.**
  `getOrCreateStringIds` (step 13) runs its own `INSERT OR IGNORE` batch before
  the main transaction, so if the transaction rolls back, any *newly created*
  string rows linger with `used_count = 0`. This is harmless: they are deduped by
  the unique `text_index`, reused on the next import attempt, and the
  `attendee_answers` delete trigger only prunes strings that were actually
  referenced. The importer must therefore **not** assume rollback removes string
  rows. (If we later want truly zero side effects on failure, fold the string
  upserts into the same guarded transaction and resolve ids within it — extra
  complexity that is not worth it for the first pass.)
- The `attendee_answers` XOR/validation triggers will `ABORT` a malformed answer
  row (e.g. both `answer_id` and `string_id` set). The importer only ever writes
  the text-answer shape (`answer_id` NULL, `question_id` + `string_id` set), so a
  trigger abort here means an importer bug, not bad data — let it roll the
  transaction back rather than catching it.
- Keep this design explicit in tests. A late-row failure must leave no earlier
  attendees, listing links, text answers, or import-map rows.

## Missing Setup Error Page

Input:

- `GET /admin/imports/bookings/missing?product=Name%201&status=Cancelled&question=Surface`

Behavior:

- Dedupe and sort missing products, statuses, and required custom-question
  names for display.
- Escape names normally in HTML.
- Render each missing product as a link:
  `/admin/listing/new?import_name=<encoded name>`.
- Render each missing status as its exact required name plus a link to
  `/admin/settings/statuses/new`.
- Render each missing required custom question as its exact required text plus a
  link to `/admin/questions`, with copy telling the operator to create it as a
  **free-text** question with that exact text (optionally a prefilled
  `?import_text=` link, mirroring the listing flow).
- Include a link back to the upload page.
- Text should tell the user to create the missing setup, then upload the CSV
  again.

No source booking details need to be stored for this page. The CSV upload is
retried after products/statuses/questions exist.

## Tests

Add focused tests before broad route tests:

- CSV parser handles BOM, quotes, commas, duplicate headers, repeated `Date`
  columns, and empty cells.
- Product extractor handles:
  - populated authoritative `Equipments`;
  - empty `Equipments` plus `Quoted for Products` fallback;
  - ignoring extra product-looking text in notes when `Equipments` is populated;
  - duplicate product names;
  - names containing slash characters with longest known-name matching first.
- Product resolver reports missing names and does not write anything.
- Status resolver maps source `Status` values to existing attendee statuses,
  reports missing status names, and does not write anything.
- Cancelled source rows import with the matching `Cancelled` status.
- Missing-setup route renders product links with encoded `import_name` params
  and lists missing statuses and missing free-text questions.
- New-listing form locks `import_name` and POST enforces it server-side.
- Import map skips already-imported source IDs.
- Import rejects duplicate source IDs in the same CSV.
- Whole-file transaction rolls back all writes when a later row fails —
  explicitly assert that no `attendees`, `listing_attendees`, `attendee_answers`,
  or `booking_imports` rows survive a forced late-row failure.
- Daily listings receive date ranges; standard listings get undated rows and a
  report warning.
- Legacy rows can overbook without failing the import.
- Financial mapping sets listing line `price_paid` to `0`, preserves raw totals
  in answers/report, and does not change listing income.
- Raw concatenated/invalid emails are imported without splitting or rejecting
  the row.

Free-text question tests (the PR #1335 surface):

- A configured column with a matching `free_text` question creates an
  `attendee_answers` text row (`answer_id` NULL, `question_id` + `string_id`
  set), and `getAttendeeTextAnswers(attendeeId, privateKey)` reads back the exact
  source text.
- A non-empty configured column with **no** matching free-text question blocks
  the import before writes and is listed on the missing-setup page.
- Radio/select questions are **not** treated as import targets even if their text
  matches a CSV header.
- Identical answer text across two bookings is deduped into a single `strings`
  row (assert one row / shared `string_id`), and the import is written through a
  single `getOrCreateStringIds` call rather than per-attendee saves.
- At most one text answer per `(attendee, question)`: a booking that would map
  the same question twice produces exactly one answer row (no unique-index
  abort).
- Imported answers are written using the owner public key only (no unwrapped
  private key required for the write path).

## Implementation Phases

1. Schema and import-map helper
   - Add `booking_imports` (migration sequenced after
     `2026-06-20_free_text_questions`).
   - Add narrow helpers to fetch existing old IDs and insert mappings.
   - Reconcile the legacy-notes destination with the #1332/#1333 notes rework
     (decide column vs per-contact record vs report-only for the raw audit
     trail). Free-text questions cover the high-value columns regardless.
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
     text, free-text only).
   - Apply longest-match-first product resolution and no aliases.
   - Missing-setup error route (products + statuses + questions).
   - Listing-name prefill/lock flow; optional status/question text prefill.
4. Import planner
   - Build a pure import plan from source rows plus existing
     listings/statuses/questions/imports.
   - No database writes from this layer.
   - Produce per-attendee text-answer sets (`{ questionId, text }`), deduped per
     booking.
   - Report skipped, creatable, missing setup, warnings, and unmapped metadata.
5. Transactional writer
   - Resolve all text answers via a single `getOrCreateStringIds` call.
   - Convert the import plan into attendee / listing_attendee / attendee_answers
     (text) / import-map writes in one guarded transaction.
   - Write status ids, free-text answers, logistics times, raw balances, and
     zero listing income.
   - Allow overbooked legacy rows.
   - Prove whole-file rollback (including text answers).
6. Admin upload route
   - Wire upload form, parser, planner, writer, success/error redirects.
   - Add nav entry if desired.
7. Full coverage and precommit
   - Route tests, DB tests, parser tests, and coverage closure.

## Resolved Decisions

- Source `Status` drives attendee status. `Colour Name` is legacy metadata.
- Missing source statuses block the upload before writes, like missing products.
- Cancelled rows import with a matching local `Cancelled` status.
- Legacy imports may overbook.
- Imported financial totals do not affect listing income; line `price_paid` is
  always `0`.
- Raw emails are imported as source data, including concatenated or invalid
  values.
- `Equipments` is authoritative when populated. Notes/modifiers do not add
  products to populated `Equipments` rows.
- There is no product/status/question alias mechanism. Matching is normalized
  exact matching, with longest-match-first product scanning for names containing
  slashes.
- Legacy free-text columns are imported as **free-text question answers**
  (PR #1335): the operator creates `free_text` questions whose text matches the
  CSV headers; the importer stores source values as owner-key-encrypted,
  deduplicated `strings` referenced from `attendee_answers`. Missing required
  free-text questions block the upload before writes, like missing products and
  statuses.
- The importer reuses PR #1335's `strings`/`attendee_answers` schema and helpers
  and does not redefine them; `booking_imports` is the only new table.
- The raw audit-trail dump's storage location is deferred to align with the
  #1332/#1333 notes rework and is not a blocker for a first importer pass.
