# Designing new systems

When planning a new feature, design it to have every quality below. Each one
names reference implementations in this codebase — read the exemplar before
designing, and copy its shape rather than inventing a new one. These are the
systems we want more of.

## Schema-tized

Model the thing as data first — a typed schema plus a few functions folded over
it — and derive everything else (types, validation, rendering, routes) from that
one declaration. The philosophy is in the Preferences of AGENTS.md ("Schema over
organic structure", "Shared interfaces over branch-per-case"); these are the
mechanisms to copy:

- **A valibot schema as the single source of truth for a value type.** Declare
  once; derive the TS type, the runtime guard, and the options list:

  ```typescript
  export const ContactFieldSchema = v.picklist([
    "email",
    "phone",
    "address",
    "special_instructions",
  ]);
  export type ContactField = v.InferOutput<typeof ContactFieldSchema>;
  export const CONTACT_FIELDS = ContactFieldSchema.options;
  export const isContactField = (s: string): s is ContactField =>
    v.is(ContactFieldSchema, s);
  ```

  See `src/shared/types.ts` (six of these) and `src/shared/price-modifier.ts` (a
  whole family). For structured values, compose `v.object` schemas into a
  discriminated union with `v.variant("kind", […])` and a single `v.is` guard —
  `src/shared/bulk-email-targets.ts` is the reference.
- **Declarative tables.** `defineTable`/`defineIdTable`
  (`src/shared/db/table.ts`, `src/shared/db/define-id-table.ts`): a `columns`
  config built from the `col.*` builders (`col.boolean`, `col.encrypted`,
  `col.generated`, …) drives serialization, encryption, and the derived `Input`
  type. Never hand-write row mapping.
- **Config-driven CRUD.** `defineCrudApi` (`src/shared/rest/crud-api.ts`) turns
  one config object into the five standard admin API routes;
  `defineResource`/`defineNamedResource` (`src/shared/rest/resource.ts`) turn
  `{table, fields, toInput, validate}` into typed operations that the handlers
  in `src/shared/rest/handlers.ts` wire to HTTP.
- **Schema-driven forms.** `defineForm` + a `Field[]`
  (`src/shared/forms/definition.ts`): one field list drives the HTML rendering,
  the parsing/validation, and the `FormValuesFor<>` value types;
  `createFormRoute`/`createAuthedFormRoute` (`src/shared/app-forms.ts`) wire
  that same schema to both the GET (render) and POST (validate) handlers.
- **Form section headers are a `FormSection[]`, never a hand-rolled heading.** A
  form's grouped sections are modelled as data — a `FormSection[]` (`legend`
  - `children`) rendered by `FormSections`
    (`src/ui/templates/components/aggregate-sections.tsx`), which turns each
    entry into a legend-led `SectionFieldset`. A single section uses
    `SectionFieldset` directly. Never head a form section with an `<h3>`/`<h4>`
    — a `<legend>` is the section header, and routing every section through
    `FormSections`/`SectionFieldset` keeps that so. The listing form
    (`listings/form-sections.tsx`) and the attendee form
    (`admin/attendee-form.tsx`) both build a `FormSection[]`; see them for
    conditional sections (`compact` drops the ones that do not apply).
- **One vocabulary for "attached to any record".** `defineRecordTarget`
  (`src/shared/db/record-target.ts`): a domain says which kinds of record it
  accepts and which two columns hold the kind and the id, and gets back the
  naming (`of("listing")(7)`), a stable `key`/`fromKey` pair, the
  `where`/`whereMany`/`whereChosenBy` clauses, the matching deletes, and an
  existence check. Notes (`src/shared/db/notes/target.ts`), image links
  (`src/shared/db/images.ts`), and site page items
  (`src/shared/site-pages/target.ts`) all use it — a fourth "attach something to
  any record" feature declares its kinds, it does not invent a fourth
  vocabulary.
- **A data table plus one fold.** `LISTING_DEFAULT_FIELDS` +
  `resolveListingDefaults` (`src/shared/listing-defaults.ts`); the admin guide's
  `GuideSection[]` + `renderGuideSections`.

If your plan contains a hand-rolled dispatcher, an ad-hoc form, bespoke CRUD
routes, or hand-written row (de)serialization, stop: there is a `define*`
factory for that already. Use it — or extend it for every caller.

## Checked forwards and backwards

A stateful lifecycle is declared as a machine, its combinations with other
machines are declared as a seam, and both declarations are checked in both
directions: forwards by tests that drive the real transitions and crash them
mid-flight, backwards by reading the stored data and proving it fits. This was
retrofitted onto the payment machines across three large PRs (#2065, #2079,
#2084); a new lifecycle declares it with its first slice, when it is cheap. The
mechanisms, each with its reference:

- **Declare the machine as data.** Nodes carrying representative states built
  through the production transitions, events, and an exhaustive moves table — a
  cell missing from the table is a declared refusal, never a fallthrough. The
  framework is `src/shared/schema-atlas/machine-spec.ts`; the machines are
  `src/shared/payment/{row,refund,review,sumup-recovery}-machine-spec.ts`, with
  whole-graph properties (all reachable, all can end, one declared
  provider-wait) in their `graph.test.ts` suites over the shared
  `#test-utils/machine-graph.ts` walker.
- **Derive, never restate.** SQL guards (`rowWorkMirrorSql`), status words,
  danger flags, and the operator map (`SCHEMA_ATLAS_MACHINES`, rendered at
  `/admin/schema`) all derive from the spec. Vocabulary lists derive from the
  machine's own types — an exhaustive mapped record keyed by the machine's union
  (`STORED_AUTHORITY_FACTS` in `src/shared/payment/joint-state.ts`) — so a grown
  or renamed state stops compiling until every consumer learns it.
- **Declare the seam.** When two machines share reality, declare the ILLEGAL
  combinations, each entry naming the invariant it breaks
  (`ILLEGAL_JOINT_STATES` in `src/shared/payment/joint-state.ts`). List only
  what is provably impossible: every crash window's intermediate state must stay
  legal, because a redelivery has to finish from it.
- **Witness every manufactured crash.** Each crash-manufacture test helper reads
  back every stored record it touched and asserts the combination is one a real
  run can produce (`expectLegalJointStates` in
  `test/test-utils/joint-state.ts`), so the whole crash suite polices the seam
  without new tests.
- **Enumerate flows × crash windows.** List every flow; every await between two
  durable writes is a window; each window gets an idempotent-redelivery proof or
  a fault-injected test. Faults are triggers at SQLite's own boundary, not stubs
  (`test/test-utils/db-fault.ts`), so the failing write rolls back exactly as
  production would.
- **Check backwards from the data.** A bounded scan reads the declared
  impossibilities back out of the live database and shows the operator every hit
  (`src/shared/db/schema-anomaly-scan.ts`, the `/admin/schema` "Live check").
  Key the scan's queries by the declaration table's own literal types, so
  declaring a new illegal combination refuses to compile until the scan knows
  how to find it.

## Pure, functional

Write the core of a feature as pure data-in/data-out functions and keep IO (DB
reads, settings, fetches) in a thin shell around it. Pure modules are trivially
unit-testable, which is what keeps 100% coverage and a 100% mutation kill rate
cheap to sustain.

- `src/shared/largest-remainder.ts` — a complete allocation algorithm with zero
  imports; the hardest logic in the money paths and the easiest to test.
- `src/shared/listing-defaults.ts` — the header states "This module is pure":
  callers fetch, it computes.
- `src/shared/ledger/project.ts` — pure projections over a slice of transfers;
  every derived total reuses the single `allBalances` fold, so no two totals can
  disagree.
- `src/shared/phone.ts`, `src/shared/countries.ts` — pure normalization, and a
  pure data table with total accessors.

Prefer the curried utilities from `#fp` over imperative loops (see "FP Imports"
in AGENTS.md). When a module needs both computation and configuration, split it
the way `src/shared/dates.ts` does: the pure functions take the timezone as an
argument, and thin wrappers inject `settings.timezone` — the pure core stays
testable without a database.

## Modularised

One concept per file; one layer per directory. `REPO_STRUCTURE.md` defines where
things go (`src/features/*` routes, `src/shared/*` domain logic, `src/ui/*`
presentation). Within `shared/`, the shapes to copy:

- `src/shared/rest/` — `resource.ts` (the resource abstraction), `handlers.ts`
  (HTTP wiring), `crud-api.ts` (the JSON API): each file is one layer, named for
  its job.
- `src/shared/ledger/` — `types.ts`, `project.ts`, `account.ts`, `reconcile.ts`:
  a domain split into files you can navigate blind.
- `src/shared/db/attendees/` — `queries.ts`, `pii.ts`, `capacity.ts`,
  `stats.ts`, `delete.ts`: a big table's concerns separated instead of one
  1,500-line module.

A new system must arrive as a small directory of single-purpose files, not one
grab-bag module — and not as fragments scattered through unrelated existing
files.

## Well-named files

The filename states the concept; the concept fills the file.
`largest-remainder.ts`, `phone.ts`, `slug.ts`, `define-id-table.ts`,
`request-cache.ts`, `keyed-cache.ts` — you can guess each file's exports from
its name and vice versa. Function names carry contracts the same way: the `Raw`
suffix on `getAttendeesRaw`/`getAttendeeRaw` means "PII still encrypted —
decrypt before display", and `getUserDisplayFields` names the exact narrow
column set it selects. If you cannot name the file in a couple of words, it is
probably two concepts — split it.

## Valibot and standard libraries

Validation is valibot; collections are `@std/collections` (via `#fp`); paths,
media types, and cookies are `@std/path`, `@std/media-types`, and
`@std/http/cookie`; date/timezone math is `Temporal` (temporal-polyfill);
formatting is `Intl`. Valibot patterns to copy:

- **Branded scalar** — `src/shared/validation/email.ts`:
  `v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.brand("ValidEmail"))`.
  A `ValidEmail` can only be produced by validation, so downstream code needs no
  re-checks.
- **Coercing schema factory** — `src/shared/validation/number.ts`:
  `createIntSchema(minimum)` validates digits _before_ `v.transform(Number)`
  (closing the `parseInt("5abc")` hole); `PositiveIntSchema` and friends are its
  specializations.
- **Boundary validation** — `src/features/api/sms-webhook.ts`: `v.safeParse` an
  envelope `v.object` immediately after `JSON.parse`, 400 on failure. Validate
  at the boundary; pass typed values inward.
- **Deliberate non-use is fine when the platform is better** —
  `src/shared/validation/timestamp.ts` delegates instant validation to
  `Temporal.Instant.from` (valibot's `isoTimestamp` accepts overflow days) and
  documents why.

## Do not reinvent the wheel

Before writing an algorithm, formatter, or parser, check `deno.json` — the
answer is usually already a dependency. When the project's calling convention
differs from a library's, write a thin adapter; do not re-implement:

- `src/fp.ts` — `unique`, `uniqueBy`, `mapNotNullish`, `sumOf`, `chunk` are
  one-line curried adapters over `@std/collections`.
- `src/shared/db/table.ts` — `toCamelCase`/`toSnakeCase` delegate to valibot's
  case actions rather than bespoke regexes.
- `src/shared/timezone.ts` — all DST/offset math is `Temporal`;
  `src/shared/currency.ts` gets currency symbols and decimal places from
  `Intl.NumberFormat` instead of a hand-maintained table; `src/shared/slug.ts`
  validates with `v.slug()`.

When you genuinely must hand-roll, document the reason at the definition the way
`#fp`'s `groupBy` does (it exists because `@std/collections` lacks the ordering
guarantee its callers rely on).

## Curried helpers

Currying is the house style for both de-duplication (see "Code Duplication" in
AGENTS.md) and API design: the factory takes the configuration, the returned
function takes the data.

- `makeOutcome(succeeded)` → `export const ok = makeOutcome(true)` /
  `fail = makeOutcome(false)` (`src/shared/response.ts`).
- `roleIn(levels)` → `isStaffRole`, `isDeliveryRole` (`src/shared/types.ts`) —
  predicate factories instead of near-identical functions.
- `balanceOf(account)` → `(transfers) => number` and friends
  (`src/shared/ledger/project.ts`) — curried projections that compose.
- At larger scale the same shape becomes the config-driven factories:
  `defineTable`, `defineCrudApi`, `defineForm`, and `cachedClientFactory`
  (`src/shared/payment-helpers.ts`).

## Built for cold starts

Most production requests land on a freshly booted edge isolate with a ~500ms
startup budget and a limited subrequest budget
(`scripts/bench/cold-start/bundle-load.ts` measures single-file load and
`scripts/bench/cold-start/first-request.ts` measures request round trips). The
rules, with their reference implementations:

- **Nothing heavy at module load.** Entry points only register the handler
  (`src/edge.ts`); app boot runs `once()` on the _first request_
  (`src/serve-app.ts`). Module-load work is fine only when pure and cheap (for
  example `defineTable` building its schemas once).
- **A foundation module must not reach the database.** `#shared/env.ts`,
  `#shared/now.ts` and the crypto modules load before anything else, so a new
  import in one of them can close a ring back to itself. Whichever module the
  runtime then evaluates second reads a name the first has not reached yet, and
  the app dies at startup with "Cannot access X before initialization". Which
  module loses that race depends on the entry point, so such a ring can pass the
  whole Deno suite and take every Cucumber Feature down. When a foundation
  module needs a helper, put the helper in a module that imports nothing, the
  way `parseDateMs` sits in `#shared/now.ts` rather than in `#shared/dates.ts`,
  which reads a site's timezone from the database.
  `test/integration/import-cycles.test.ts` holds `src/` at the rings it already
  carries, and that list only shrinks.
- **Lazy singletons via `once`/`lazyRef` from `#fp`.** The DB client (`getDb` in
  `src/shared/db/client.ts`), the dynamically imported Stripe SDK
  (`src/shared/stripe.ts`), the Liquid email engine, crypto key material — all
  first-use, never import-time.
- **Request-scoped memoization, not global state.** `requestCache`
  (`src/shared/request-cache.ts`) shares one fetch among all callers within a
  request. Any new per-request state is built on one of the three factories in
  `src/shared/request-scoped.ts` (`createScope`, `createScopedValue`,
  `createRequestScoped`) — the only module allowed to touch `AsyncLocalStorage`
  — so two concurrent requests on one isolate cannot clobber each other and a
  leaked post-request context always reads as "outside a request". Isolate-lived
  caches are best-effort and bounded (`src/shared/db/keyed-cache.ts`; the
  settings version-stamp cache in `src/shared/db/settings.ts`) — never
  authoritative for security decisions, and invalidated automatically by the
  write-sniffing db client (`src/shared/cache-registry.ts`).
- **Compile once, render many.** ICU message templates (including the
  `I18N_REPLACEMENTS` rebranding pass) compile once and cache
  (`src/shared/i18n.ts`), so rendering is a plain format call.
- **Respect the subrequest budget.** Fixed-cost designs like
  `src/shared/limits.ts` (one SELECT plus one batch regardless of batch size),
  `UPDATE … RETURNING` instead of update-then-select (`src/shared/db/table.ts`),
  and `queryBatch` for multi-read round-trips. Bunny has a hard limit of 50
  subrequests per request. One libsql `execute`, batch, transaction
  begin/statement/commit/rollback, or external fetch counts as one; statements
  inside one batch still count as one. The client guard blocks database call 51,
  but routes that also call providers or storage must target at most 40 database
  calls so those other fetches still fit.
- **Model realistic database latency.** The request benchmark uses 0, 5, 10, and
  20 ms per libsql round trip. Treat 20 ms as the expected worst case for a
  replicated database; do not publish 50 or 100 ms projections as realistic
  production measurements without evidence from production.

A new feature that adds a top-level `await`, an import-time SDK load, or a
per-request whole-table read is a cold-start regression even if it works.

## Efficient SQL

The rules live in "Database Queries" in AGENTS.md (narrow column lists, bounded
reads, batches vs interactive transactions). Beyond those, copy these shapes:

- **Enforce invariants in the mutating statement itself.**
  `src/shared/db/capacity.ts` embeds the capacity check in the same
  INSERT/UPDATE that books the attendee — no read-modify-write race, no second
  round-trip.
- **Trigger-maintained aggregates instead of scans.**
  `listings.booked_quantity`/`tickets_count` are maintained by triggers on
  `listing_attendees`
  (`src/shared/db/migrations/2026-06-16_listing_aggregates.ts`), so listing
  reads never sum attendee rows.
- **One-round-trip patterns.** `UPDATE … RETURNING *` in
  `src/shared/db/table.ts`; `queryBatch`/`executeBatchWithResults` in
  `src/shared/db/client.ts`; keyset pagination for unbounded reads
  (`src/shared/db/backup.ts` with `BACKUP_PAGE_SIZE`).

## Decrypt only what you need

Encrypted data stays encrypted until the moment of display, and lookups never
require decryption:

- **Blind HMAC indexes for lookups.** Alongside each searchable encrypted value
  sits a deterministic `hmacHash` index column: `username_index`
  (`src/shared/db/users.ts`), `ticket_token_index`
  (`src/shared/crypto/hashing.ts`, `src/shared/db/attendees/queries.ts`),
  `phone_index` for inbound SMS (`src/shared/db/attendee-phone-index.ts`),
  `code_index` on modifiers. Query `WHERE …_index = ?`; never scan-and-decrypt.
  (The one sanctioned scan-decrypt — invite codes in `users.ts` — is documented
  and bounded by a tiny keyspace.)
- **One blob, one decrypt, decrypt late.** All attendee PII lives in a single
  `pii_blob` (`src/shared/db/attendees/pii.ts`); list queries select it without
  decrypting (`getAttendeesRaw` and friends in
  `src/shared/db/attendees/queries.ts`), and `decryptAttendees` runs only at
  render time. `decryptPiiBlob`'s `paidListing` flag even gates which fields
  come out of the blob, and `getAttendeeNamesByIds` decrypts just the name.
- **Skip encrypted columns entirely when you can.** `getUserAuthFieldsById`
  (`SELECT id, admin_level`) and `getAttendeeKindsByIds` (`SELECT id, kind`)
  answer their questions without touching a ciphertext — the same discipline as
  "Select only needed columns", applied to plaintext-in-memory.
- **Declarative encryption at the column layer.**
  `col.encrypted`/`col.encryptedText` in `src/shared/db/table.ts` decrypt
  lazily, per present column; a new encrypted column is declared, not
  hand-wired.
- **Keys are request-scoped and short-lived.** The session private key is
  fail-closed per request (`src/shared/session-private-key.ts`) and decrypt
  caches are TTL-bounded to seconds (`src/shared/crypto/keys.ts`).
