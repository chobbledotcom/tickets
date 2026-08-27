# BUSINESS_LOGIC_TODOS — centralise shared business rules

This file tracks opportunities to schema-tize business logic that is still
declared more than once across `src/` and `test/`. The aim: declare each rule
**once** as data, derive everything else (routing, nav, guards, redirects, form
options, read-only blocking, tests) from that one declaration.

The codebase already has proven "data table plus one fold" patterns to copy:
`LISTING_DEFAULT_FIELDS` + `resolveListingDefaults`
(`src/shared/listing-defaults.ts`), the `GuideSection[]`
(`src/ui/templates/admin/guide/`), the provider/settings/bulk-email-targets
registries, and the `TabDef`/`EntityPageDef` in `entity-pages`. Each item below
names the exemplar to follow.

---

## 1. `adminLandingPath` is a second role→route map

**Problem.** `adminLandingPath` (`src/features/auth.ts`) hand-maintains where
each role lands after signing in: agent → `/admin/deliveries`, editor →
`/admin/listings`, everybody else → `/admin`. The admin surface already knows
every section's audience and its landing pattern
(`src/shared/admin-surface/areas.ts`, `landingPattern` in
`src/shared/admin-pages.ts`), so the same fact is written twice and only care
keeps the two together.

**One obstacle to clear first.** The existing navigation folds cannot answer
this on their own. `visibleAdminSections` keeps a section only when the
section's own **landing** route admits the viewer, and `visibleSections` then
drops every section with a single link. An agent's only page,
`/admin/deliveries`, is a nav child of the Calendar section, whose landing is
staff-only, so an agent sees no section at all through those folds. Deriving the
landing from "the first visible section" would therefore leave an agent with
nowhere to go.

**Plan.** Give the declaration the fact it is missing, then delete the
hand-written map. Either mark a preferred landing per role on the section, or
make Deliveries its own section whose landing admits agents. Keep a test that
every role lands somewhere it may open — that is the property the map holds
today by hand.

**Exemplar:** `visibleAdminSections` / `visibleSections` in
`src/shared/admin-pages.ts` for the fold to extend, and `sectionVisible` for the
audience rule the new fact has to sit beside.

---

## 2. Post-action redirect targets

**Shipped:** `entityReturnPath(sectionPath, id)` in `src/shared/admin-pages.ts`
sends a reader to a record's own page, or to the section list when the section
has no record page.

**Not yet schema-tized** (lower priority — each is a hand-written `redirect`
call in a single handler): the "back to the list" pattern (modifiers, images,
sessions, servicing, users, and about five more), the `return_url` honouring
pattern (attendees, refunds), and the `getRowPath` config in
`src/features/admin/crud-handlers.ts`. These could be an `afterSave` field on
the declaration naming the detail, edit, or list landing, but each has
per-handler nuances (`return_url` threading, `formId` anchors) that make a
one-size fold less clean than the record-vs-list rule that shipped.

---

## 3. `READ_ONLY_SAFE_PATHS` is still hand-maintained

**Shipped:** the read-only GET patterns derive from
`readOnlyGetRoutePatterns()`, which reads every destination the admin surface
declares as a write form.

**Problem.** `READ_ONLY_SAFE_PATHS` (`src/features/app/read-only.ts`) — the
allowlist of non-admin routes that stay writable in read-only mode (auth,
billing, webhooks, check-in, and the rest) — is still a hand-maintained list.
These are public and inter-instance routes, not admin-section routes, so they do
not fit the admin-page schema naturally. A separate `READ_ONLY_SAFE_ROUTES`
schema could consolidate them, but the list is stable and low-risk.

---

## 4. Content form length limits

**Problem.** `src/features/admin/content-form-fields.ts` declares three magic
constants that are local to the module, not exported, and not schema-derived:

- `MAX_NAME = 128`
- `MAX_META_TITLE = 64`
- `MAX_META_DESCRIPTION = 160`

No test references them by symbol — they are tested only through form
validation. A new content form that reuses the same fields cannot import the
limits.

**Plan.** Export a small `CONTENT_FIELD_LIMITS` table (or simply export the
constants) and have tests import them. Alternatively, derive the `maxlength`
from a valibot `v.pipe(v.string(), v.maxLength(N))` schema per field, so the
limit is declared once on the type and the form field's `maxlength` reads from
the schema.

**Exemplar:** `createIntSchema(minimum)` (`validation/number.ts`) validates
digits before `v.transform(Number)` — the schema IS the limit. Apply the same
pattern to content string fields.

---

When taking any item, follow the codebase conventions: put the schema in
`src/shared/` (pure, data-in/data-out), keep the IO shell thin, and migrate
every caller in the same change. Run `deno task precommit` to verify.
