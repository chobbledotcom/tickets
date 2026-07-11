# BUSINESS_LOGIC_TODOS — centralise shared business rules

This file tracks opportunities to schema-tize business logic that is currently
duplicated across `src/` and `test/` or scattered across multiple call sites.
The aim: declare each rule **once** as data, derive everything else (routing,
nav, guards, redirects, form options, read-only blocking, tests) from that one
declaration.

The codebase already has proven "data table plus one fold" patterns to copy:
`LISTING_DEFAULT_FIELDS` + `resolveListingDefaults`
(`src/shared/listing-defaults.ts`), the `GuideSection[]`
(`src/ui/templates/admin/guide/`), the provider/settings/bulk-email-targets
registries, and the `TabDef`/`EntityPageDef` in `entity-pages`. Each item below
names the exemplar to follow.

Items are ordered hardest-first where the ordering matters (an admin-page
schema unblocks several dependents).

---

## 1. Admin page & route schema

**Problem.** There is no single shared declaration of "these are all the admin
pages, their paths, and the role each requires." The knowledge is spread across
five surfaces that must be kept in sync by hand:

1. **Nav links + role-gating** — hand-wired inline in `nav.tsx`
   (`session.adminLevel === "owner" ? … : null`, two separate top-level lists
   for staff vs editors, ten `*Sub()` builders).
2. **Route keys** — declared as `"METHOD /path"` strings in ~40 separate route
   modules, merged into a flat `Record` in `admin/index.ts` with zero role
   metadata.
3. **Role enforcement** — baked inside each handler via auth primitives
   (`ownerPage`, `requireContentOr`, `withAuth(request, OWNER_FORM, …)`),
   invisible to the router and the nav.
4. **`active=` highlighting** — hardcoded per template
   (`active="/admin/ledger"`, `active={{ section: "/admin/listings" }}`) in ~36
   call sites, none derived from the route key.
5. **`adminLandingPath`** (`auth.ts:131`) — a second hand-maintained role→route
   map (agent → `/admin/deliveries`, editor → `/admin/listings`, else →
   `/admin`).

Tests re-derive all of this: `nav.test.tsx` hand-types three parallel tables
(`addLinkSections`, `withinSectionCases`, `deepPages`), `server-editor.test.ts`
hardcodes every route the editor may and may not reach, and
`server-owner-routes.test.ts` hand-lists the owner-only GET/POST routes.

**Plan.** Create `src/shared/admin-pages.ts` — a declarative table that is the
single source of truth for every admin section and its routes. Each entry
carries:

- **`basePath`** — the section's landing route (e.g. `/admin/listings`).
- **`labelKey`** — i18n key for the nav label.
- **`guard`** — one of the existing role-set constants (`STAFF_ADMIN_LEVELS`,
  `CONTENT_ADMIN_LEVELS`, `SITE_ADMIN_LEVELS`, `DELIVERY_ADMIN_LEVELS`) or
  `"owner"` / `"all"`.
- **`featureFlag?`** — an optional predicate (`isStorageEnabled`,
  `isSupportEnabled`, `isBuilderEnabled`, `settings.showPublicSite`,
  `settings.hasLogistics`, `isReadOnly`).
- **`subNav?`** — a list of sub-entries, each itself a `{ href, labelKey,
  guard?, featureFlag? }` (so the "Add X" create links, the Settings sub-pages,
  etc. are data, not hand-built functions).
- **`activeKey`** — the string pages pass to `AdminNav` instead of hand-typing
  `active="/admin/ledger"`.

Fold functions derive:
- `navItemsForRole(adminLevel)` → the top-level nav + sub-navs (replaces
  `topLevelItems`, `editorTopLevelItems`, `sectionsForRole`, all ten `*Sub()`
  builders).
- `routesForSection(section)` → the route keys the section owns (so the
  `admin/index.ts` merge can validate every route is declared).
- `adminLandingPath` → derived from the schema's first visible section per role
  (replaces the hand-maintained map in `auth.ts`).
- The read-only GET patterns (item 4 below) — derived from which entries have a
  create/edit sub-page.

Migrate `nav.test.tsx`, `server-editor.test.ts`, and `server-owner-routes.test.ts`
to import constants from the schema instead of re-typing hrefs and role lists.
The `addLinkSections` table in `nav.test.tsx` becomes a projection of the
schema's `subNav` entries where the href ends in `/new`.

**Exemplar:** `LISTING_DEFAULT_FIELDS` + `resolveListingDefaults`
— a typed array with per-entry predicates + a fold that replaces inline
if/else. The `entity-pages` `EntityPageDef` is the structural model (a section
is a `basePath` + a `guard` + a list of children, just like a page is a
`basePath` + a `guard` + a list of tabs).

**Scope note:** This is the largest item and unblocks items 2, 4, and 8.
The migration can be gradual: build the schema, have `nav.tsx` consume it first
(replacing the hand-wired builders), then migrate tests, then derive
`adminLandingPath` and the read-only patterns.

**Status: Shipped.** The schema (`src/shared/admin-pages.ts`) is the single
source of truth for every admin nav section — its landing route, role set,
feature-flag predicates, sub-nav links, mutating GET routes (edit/delete/
duplicate patterns), and role-aware detail-vs-edit redirect metadata.

- `nav.tsx` consumes the schema folds (`visibleTopLevel`, `visibleSections`)
  instead of ~200 lines of hand-wired builders (`editorTopLevelItems`,
  `topLevelItems`, ten `*Sub()` functions, `sectionsForRole`).
- `nav.test.tsx`'s `addLinkSections` and `withinSectionCases` tables derive
  from `createLinkSections()` instead of being hand-typed — new sections are
  covered automatically.
- `READ_ONLY_GET_PATTERNS` (item 4) is derived from the schema's
  `readOnlyGetRoutePatterns()`, replacing the hand-maintained 19-regex list.
- `entityReturnPath` (item 2) is derived from the schema's `detailPath` +
  `staffOnlyDetail` fields, replacing `admin-paths.ts` (which was deleted).
- All 5 callers of the old `listingReturnPath`/`groupReturnPath` helpers now
  call `entityReturnPath("/admin/listings", adminLevel, id)` directly.

**Remaining (not yet done):**
- Migrating `server-editor.test.ts` / `server-owner-routes.test.ts` to import
  role expectations from the schema instead of hand-typing route lists.
- Deriving `adminLandingPath` (`auth.ts:131`) from the schema's first visible
  section per role (currently still a hand-maintained map).

---

## 2. Post-action redirect targets

**Status: Shipped.** The `entityReturnPath(sectionPath, adminLevel, id)`
function in `admin-pages.ts` derives from the schema's `detailPath` and
`staffOnlyDetail` fields. Listings and Groups declare `detailPath` +
`staffOnlyDetail: true` in the schema; `entityReturnPath` sends editors to
the edit form and staff to the detail page. The old `admin-paths.ts` (which
hardcoded `/admin/listing` and `/admin/groups` base paths) was deleted; all
callers now use the generic `entityReturnPath` with the section's basePath.

**Not yet schema-tized** (lower priority — each is a hand-written `redirect`
call in a single handler): the "back to the list" pattern (questions,
modifiers, images, sessions, deliveries), the `return_url` honouring pattern
(attendees, refunds), and the `getRowPath` config in `owner-crud.ts`. These
could be extended by adding an `afterSave: "detail" | "edit" | "list"` field
to the schema, but each has per-handler nuances (role-split landing pages,
`return_url` threading, `formId` anchors) that make a one-size fold less
clean than the detail-vs-edit rule that shipped.

---

## 3. `limits.ts` — unify the dual declaration into one table

**Status: Shipped.** Each limit is now declared exactly once via a `limit()`
helper that reads the env var AND registers the debug-page entry in one call.
The named constant and the `LIMIT_ENTRIES` display table both derive from the
same declaration — they can never drift. The `MAX_IMAGE_SIZE` bug (32 MB
constant vs 256 KB table entry) is fixed. `ACTIVITY_LOG_BACKFILL_BATCH` is now
on the debug page (it was previously missing from `LIMIT_ENTRIES`). The sync
test's expected-keys list was updated to include the newly-surfaced entry.

---

## 4. Read-only mode patterns — derive from the admin-page schema

**Status: Shipped.** `READ_ONLY_GET_PATTERNS` in `features/index.ts` is now
derived from the schema's `readOnlyGetRoutePatterns()` fold, which collects
every subNav create-link href plus every section's `mutatingGetRoutes`
(edit/delete/duplicate/create-variant patterns). A `routePatternToRegex`
helper converts `:id` → `\d+` and `:type`/`:ref` → `[^/]+` at module load.

The hand-maintained 19-regex list was replaced. **Fixed 3 gaps**: the original
list was missing `/admin/servicing/new`, `/admin/modifiers/new`, and
`/admin/user/new` — the schema derivation catches these automatically.
Regression tests were added for all three in `read-only.test.ts`.

**Not yet derived from the schema:** `READ_ONLY_SAFE_PATHS` (the 20-pattern
allowlist of non-admin routes that stay writable in read-only mode — auth,
billing, webhooks, check-in, etc.) is still a hand-maintained list. These are
public/inter-instance routes, not admin-section routes, so they don't fit the
admin-page schema naturally. A separate `READ_ONLY_SAFE_ROUTES` schema could
consolidate them, but the list is stable and low-risk.

---

## 5. Form field options derived from picklist schemas

**Status: Shipped.** The `picklistOptions(schema, labelKeyPrefix)` helper
(`src/ui/templates/fields/picklist-options.ts`) builds a field's `options`
list from any picklist schema's `.options`, labelling each value via
`${labelKeyPrefix}.${value}`. Every field the table above named now derives
from its schema: `listing_type` and the contact `fields` checkbox group
(`fields/listing.ts` — `ListingTypeSchema`/`ContactFieldSchema`), all four
modifier selects (`fields/modifier.ts` — `CalcKindSchema`,
`ModifierDirectionSchema`, `ModifierTriggerSchema`, `ModifierScopeSchema`),
and `admin_level` (`fields/admin.ts` — `AdminLevelSchema`). Adding an enum
member surfaces in the form the moment its translation exists.

The `calc_value` bounds concern is addressed at the save boundary:
`validateModifier` (`src/features/admin/modifiers.ts`) runs
`modifierValueError`, which applies the kind-aware `validateCalcValue` rules
plus a currency-precision guard, so a crafted POST can't bypass them. The
field's inline `validate` stays a cheap finiteness pre-check for immediate
feedback.

---

## 6. Price-rule precedence as a declarative ordered list

**Status: Shipped.** `src/shared/booking/price-tree.ts` models each tier as a
`PriceRuleSpec` (`appliesTo` / `build` / `evaluate`) in the exhaustive
`PRICE_RULES` map keyed by `PriceRuleKind`, and the precedence is the
`PRICE_RULE_PRECEDENCE` ordered array (`OVERRIDE > PAY_MORE > DAY_PRICE >
BASE`). The `orderedKinds` helper makes the precedence list exhaustive at
compile time, so a new tier added to the `PriceRule` union is a type error in
BOTH tables until it has a spec and a precedence slot — no silent
fall-through. `selectPriceRule` is the one selector shared by the tree
builder's `derivePriceRule` (`build-tree.ts`) and `packageMemberPriceRule`
(webhooks, payment revalidation), and `effectivePrice` dispatches through the
same table's `evaluate`.

---

## 7. Edge compatibility error precedence as a data table

**Status: Shipped.** `edgeFieldError` (`listing-parents-rules.ts`) is now a
fold over `EDGE_ERROR_RULES` — an ordered array of `{ rejects, error }`
entries whose order IS the precedence (parent-renewal > child-renewal >
daily-type > duration): the first rule a pairing breaks decides the error, or
null when the edge is allowed. Each rule carries its own message builder (a
shared `childError` factory covers the child-blaming rules; the parent-renewal
rule names the parent), so adding a 5th rule is one new entry in its
precedence slot, never another `if` arm. The tests
(`test/shared/listing-parents-rules.test.ts`) build expected messages from the
same i18n keys via `t()` instead of re-typing the English copy, with guards
that the resolved messages are real interpolated copy (naming the blamed
listing) rather than raw-key fallbacks.

---

## 8. Capacity rules — consolidate into one declarative reference

**Status: Shipped.** `src/shared/capacity-rules.ts` is the pure declarative
table: each `CapacityRule` (`dateLessCap`, `perDateCap`, `groupPoolCap`,
`parentChildUnits`, `adminOverbookBypass`) carries an `appliesTo` predicate
over the listing facets (`listing_type` × `customisable_days`), and
`allCapacityFacets()` enumerates every combination for exhaustive tests. Both
enforcement surfaces derive from the same declaration (stage 2): the inline
SQL guard builds its type predicates from `capacityRuleTypeSql`
(`src/shared/db/capacity.ts`), and the JS preflight
(`src/shared/db/attendees/capacity.ts`) imports the same rules — so the
preflight and the write-time guard can never disagree about which check
applies.

---

## 9. `needsPayment` predicate — extract the inline boolean

**Problem.** The rule "a booking needs payment when payments are enabled AND
the listing price (or a custom-overridden price) is positive" is an inline
duplicated boolean in `processBooking` (`booking.ts:73–76`):

```typescript
const paymentsEnabled = isPaymentsEnabled();
const needsPayment =
  (paymentsEnabled && listing.unit_price > 0) ||
  (customUnitPrice !== undefined && customUnitPrice > 0 && paymentsEnabled);
```

The `paymentsEnabled &&` appears twice. It has no name and is only testable
through the full `processBooking` path.

**Plan.** Extract a pure helper:

```typescript
export const bookingNeedsPayment = (
  paymentsEnabled: boolean,
  unitPrice: number,
  customUnitPrice?: number,
): boolean =>
  paymentsEnabled && (unitPrice > 0 || (customUnitPrice ?? 0) > 0);
```

Unit-test it in isolation with table-driven examples (zero price + no custom
→ false; custom override → depends on override; payments disabled → always
false). `processBooking` reads from it.

**Exemplar:** `largest-remainder.ts` — a pure allocation algorithm with zero
imports, fully unit-tested. This is a much simpler version of the same
principle: name the rule, make it pure, test it directly.

---

## 10. `creation_failed` reasons — unify into one schema

**Problem.** The `BookingResult` union (`booking.ts:54`) defines
`reason: "capacity_exceeded" | "encryption_error"`, while
`capacity-error.ts:8–21` only special-cases `"capacity_exceeded"` and treats
everything else as fallback. These are parallel definitions of the same reason
set. Adding a new reason (e.g. `"sold_out"`) means editing the union AND the
error formatter AND every dispatcher, with a silent-fallthrough risk.

**Plan.** Create a single `FailureReasonSchema` (valibot picklist, like
`PaymentStatusSchema`), derive the `BookingResult` reason type from it, and
build a `Record<FailureReason, messageBuilder>` for the error formatter:

```typescript
export const FailureReasonSchema = v.picklist(["capacity_exceeded", "encryption_error"]);
export type FailureReason = v.InferOutput<typeof FailureReasonSchema>;

const FAILURE_MESSAGES: Record<FailureReason, (name?: string) => string> = {
  capacity_exceeded: (name) => name ? `Sorry, ${name} no longer has enough spots available` : "Sorry, not enough spots available",
  encryption_error: () => "Registration failed. Please try again.",
};
```

A new reason is a compile error in the `Record` until the message exists.

**Exemplar:** `PaymentStatusSchema` (`payments.ts:249–257`) — valibot picklist
as single source of truth for a status union.

---

## 11. Content form length limits — schema-tize

**Problem.** `content-form-fields.ts:14–16` declares three magic constants
(`MAX_NAME = 128`, `MAX_META_TITLE = 64`, `MAX_META_DESCRIPTION = 160`) that are
local to the module, not exported, and not schema-derived. No test references
them by symbol — they're tested only implicitly via form validation. If a new
content form reuses the same fields, it can't import the limits.

**Plan.** Export a small `CONTENT_FIELD_LIMITS` table (or simply export the
constants) and have tests import them. Alternatively, derive the `maxlength`
from a valibot `v.pipe(v.string(), v.maxLength(N))` schema per field, so the
limit is declared once on the type and the form field's `maxlength` reads from
the schema.

**Exemplar:** `createIntSchema(minimum)` (`validation/number.ts`) validates
digits before `v.transform(Number)` — the schema IS the limit. Apply the same
pattern to content string fields.

---

## Prioritisation

**Shipped (items 1–8):**

- **Item 1 (admin-page schema)** — the schema, nav.tsx migration, and
  nav.test.tsx migration are done. Remaining: `adminLandingPath` derivation
  and `server-editor.test.ts` / `server-owner-routes.test.ts` migration.
- **Item 2 (redirect targets)** — `entityReturnPath` is schema-driven;
  `admin-paths.ts` is deleted. The "back to list" / `return_url` patterns
  remain per-handler (lower priority — per-handler nuances make a clean fold
  harder).
- **Item 3 (limits unification)** — done; `MAX_IMAGE_SIZE` bug fixed.
- **Item 4 (read-only patterns)** — `READ_ONLY_GET_PATTERNS` is schema-derived;
  3 gaps fixed. `READ_ONLY_SAFE_PATHS` remains hand-maintained (stable, low-risk).
- **Item 5 (picklist form options)** — `picklistOptions` derives every listing,
  modifier, and invite-user select from its valibot schema; `calc_value`
  bounds enforced at save via `modifierValueError`.
- **Item 6 (price-rule precedence)** — `PRICE_RULES` + `PRICE_RULE_PRECEDENCE`
  in `price-tree.ts`; `selectPriceRule`/`effectivePrice` share the one table,
  exhaustiveness compile-enforced by `orderedKinds`.
- **Item 7 (edge error precedence)** — `EDGE_ERROR_RULES` ordered table folded
  by `edgeFieldError`; tests derive messages from the i18n keys.
- **Item 8 (capacity rules)** — `capacity-rules.ts` is the declarative table;
  the JS preflight and the inline SQL guard both derive from it.

**Remaining (items 9–11):**

Items 9, 10, and 11 are independent, small refactors that can be done in any
order.

When taking any item, follow the codebase conventions: put the schema in
`src/shared/` (pure, data-in/data-out), keep the IO shell thin, and migrate
every caller in the same change. Run `deno task precommit` to verify.
