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

**Status (partially shipped):** The schema (`src/shared/admin-pages.ts`) and
nav.tsx migration are done — `nav.tsx` now reads from the schema instead of
hand-wired builder functions. The `nav.test.tsx` `addLinkSections` and
`withinSectionCases` tables now derive from `createLinkSections()` instead of
being hand-typed. Remaining: deriving `READ_ONLY_GET_PATTERNS` (item 4 — only
4 of 19 patterns are nav create-links; the rest are deep entity routes needing
a separate route-level schema), and migrating `server-editor.test.ts` /
`server-owner-routes.test.ts` to import role expectations from the schema.

---

## 2. Post-action redirect targets

**Problem.** After a successful create/update/delete, the redirect target is
decided per-handler. There is a partial centralizer (`admin-paths.ts:
listingReturnPath` / `groupReturnPath`) but it covers only two entities. The
"back to the entity's detail page" and "back to the entity's edit page"
patterns are hand-written at every site (`/admin/questions/${id}`, `/admin/modifiers/${id}/edit`,
`/admin/listing/${id}/edit` for listing-children, `imagePath(image.id)`,
`config.editPath(id)` for money-adjust, etc.).

**Plan.** Extend the admin-page schema (item 1) to carry per-section redirect
metadata:

```typescript
interface AdminSectionDef {
  // ...fields from item 1...
  /** Where a successful create/update redirects.
   * `"detail"` → the entity's view page; `"edit"` → its edit form;
   * `"list"` → the collection. Defaults to `"list"`.
   * Can be role-aware: editors who can't open a PII detail page go to edit. */
  afterSave: "detail" | "edit" | "list" | ((role: AdminLevel, id: number) => string);
}
```

This collapses the `getRowPath` config in `owner-crud.ts`, the hand-written
redirect targets in `questions.ts`/`images.ts`/`modifiers.ts`/`listings-edit.ts`,
and the `listingReturnPath`/`groupReturnPath` helpers — all into one
field per section. `admin-paths.ts` becomes the fold that resolves the field,
and every call site reads from the schema entry instead of hand-writing a path
template.

**Exemplar:** `adminLandingPath` is the curried-shape precedent —
`(adminLevel) => string`. This generalises it from "where you log in" to "where
you land after any save."

---

## 3. `limits.ts` — unify the dual declaration into one table

**Problem.** Every limit is declared **twice**: once as a `readLimit(envKey,
default)` constant (lines 35–303) and again as a `LIMIT_ENTRIES` table entry
(lines 417–655). A test (`limits.test.ts:138–177`) exists solely to assert they
match — a smell. They have already drifted: `MAX_IMAGE_SIZE` is declared as
`32 * 1024 * 1024` (32 MB) in the constant but `256 * 1024` (256 KB) in
`LIMIT_ENTRIES` — a real bug the sync test is supposed to catch (and may be
masking because that specific entry's default mismatch needs to be verified).

**Plan.** Create a single `LIMIT_FIELDS` array (mirroring
`LISTING_DEFAULT_FIELDS`), where each entry carries `{ envKey, defaultValue,
unit, label }`, and a fold that produces both the named constant and the
`LIMIT_ENTRIES` debug list from one declaration:

```typescript
const LIMIT_FIELDS = [
  { envKey: "MAX_IMAGE_SIZE", defaultValue: 32 * 1024 * 1024, label: "Max image size", unit: "bytes" },
  ...
] as const;

// fold: derive the named exports AND the debug table
export const MAX_IMAGE_SIZE = readLimit("MAX_IMAGE_SIZE", 32 * 1024 * 1024); // still named for ergonomics
export const LIMIT_ENTRIES = LIMIT_FIELDS.map(f => ({ ...f, current: readLimit(f.envKey, f.defaultValue) }));
```

Delete the sync test — the duplication is gone by construction. Fix the
`MAX_IMAGE_SIZE` default mismatch while doing this.

**Exemplar:** `LISTING_DEFAULT_FIELDS` + `resolveListingDefaults` is the exact
"one table, two consumers" pattern. The `settings/registry.ts` is the closer
analogue (one entry → sync getter + storage mode).

---

## 4. Read-only mode patterns — derive from the admin-page schema

**Problem.** `READ_ONLY_GET_PATTERNS` (`src/features/index.ts:247–267`) is a
third hand-maintained list of admin create/edit paths (19 regexes). It must
stay in sync with the route modules, the nav sub-builders, and the
`READ_ONLY_SAFE_PATHS` allowlist (20 more patterns, maintained separately).
Any of these three lists can drift from the others silently.

**Plan.** Once the admin-page schema (item 1) exists with `subNav` entries that
carry a `create?: boolean` or `editPath?: string` flag, derive
`READ_ONLY_GET_PATTERNS` by folding over the schema:

```typescript
export const readOnlyEditPaths = pipe(
  ADMIN_PAGES,
  flatMap(section => section.subNav ?? []),
  filter(entry => entry.kind === "create" || entry.kind === "edit"),
  map(entry => entry.pathPattern),
);
```

Similarly, `READ_ONLY_SAFE_PATHS` can carry its own schema (or live as a
`readOnlySafe: true` flag on the relevant route entries). The key is: one
declaration, derived everywhere.

**Exemplar:** The `LISTING_DEFAULT_FIELDS` `appliesTo` predicate is the
precedent for per-entry conditional inclusion — a `readOnly` or `mutating`
flag on each route entry replaces a parallel blocklist.

---

## 5. Form field options derived from picklist schemas

**Problem.** Several form field definitions hand-maintain option arrays that
duplicate the declared valibot picklist schemas. The schema exports `.options`
but the form fields re-type the list. These can drift:

| Field | Schema source | Hand-maintained in form |
|---|---|---|
| `listing_type` | `ListingTypeSchema.options` (`types.ts:122`) | `getListingFields` options (`listing-fields.ts:43–44`) |
| `fields` (contact) | `CONTACT_FIELDS` (`types.ts:71`) | `getListingFields` options (`listing-fields.ts:141–147`) |
| `calc_kind` | `CalcKindSchema.options` (`price-modifier.ts:19`) | `modifierFields` options (`modifier.ts:33–37`) |
| `direction` | `ModifierDirectionSchema.options` (`price-modifier.ts:25`) | `modifierFields` options (`modifier.ts:44–47`) |
| `trigger` | `ModifierTriggerSchema.options` (`price-modifier.ts:31`) | `modifierFields` options (`modifier.ts:68–73`) |
| `scope` | `ModifierScopeSchema.options` (`price-modifier.ts:44`) | `modifierFields` options (`modifier.ts:88–93`) |
| `admin_level` | `AdminLevelSchema.options` (`types.ts:541`) | `getInviteUserFields` options (`admin.ts:288–293`) |

Tests re-derive the lists too (`listing.test.ts:259–265` re-spells the contact
fields, `listing.test.ts:278–284` hardcodes `"standard"/"daily"`).

**Plan.** Create a shared helper that builds a field's `<option>` list from
any picklist schema's `.options`, with an i18n label key template:

```typescript
export const picklistOptions = <T extends string>(
  schema: v.PicklistSchema<T>,
  labelKeyPrefix: string,
): { value: T; label: string }[] =>
  schema.options.map((value) => ({ value, label: t(`${labelKeyPrefix}.${value}`) }));
```

Replace every hand-maintained option array with `picklistOptions(Schema,
"fields.listing.type")` etc. Tests import `.options` directly from the schema
instead of re-typing the values. Adding a new enum member propagates to the
form AND the test automatically.

**Exemplar:** `CONTACT_FIELDS` is already used this way in `types.ts:71`
(`ContactFieldSchema.options` exported as `CONTACT_FIELDS`). The task is to
make every other picklist form field follow the same path. The
`content-form-fields.ts` shared builders (composed by news + site-pages) are
the structural model for how field-building functions become reusable.

**Also:** the modifier `calc_value` field's inline `validate`
(`modifier.ts:60–61`) only checks finiteness; the kind-specific bounds
(`percent ≤ 100`, `multiply > 0`) live in `validateCalcValue`
(`price-modifier.ts:84–98`) which is not wired to the field. A test exercising
the field alone misses these bounds. Wire `validateCalcValue(kind, value)`
through the field's context-built validator (the `defineForm`/`defineResource`
plumbing supports context-built validators per `app-forms.ts:99–101`).

---

## 6. Price-rule precedence as a declarative ordered list

**Problem.** The precedence `OVERRIDE > PAY_MORE > DAY_PRICE > BASE` is
documented as a comment (`booking/tree.ts:43–60`) and implemented as an
if/else in `derivePriceRule` (`build-tree.ts:68–88`) plus a switch in
`effectivePrice` (`price-tree.ts:61–80`). Adding a 5th rule (e.g. an
"EARLY_BIRD" tier) means editing the switch AND the comment AND the if-chain,
with a silent-fallthrough risk if one site is missed. This is the
"hand-rolled dispatcher" the AGENTS.md warns against.

**Plan.** Model price rules as a `Record<PriceRuleKind, evaluator>` with an
explicit `PRECEDENCE` order (an ordered array of `PriceRuleKind`), so the
precedence is a compile-enforced data fact and `effectivePrice` becomes a fold:

```typescript
const PRICE_RULE_EVALUATORS: Record<PriceRuleKind, (ctx) => number> = {
  OVERRIDE: (ctx) => ctx.rule.amountMinor,
  DAY_PRICE: (ctx) => ctx.rule.overrides?.get(ctx.dayCount) ?? dayPriceFor(ctx.listing, ctx.dayCount) ?? 0,
  PAY_MORE: (ctx) => ctx.customPrices.get(ctx.listing.id) ?? ctx.listing.unit_price,
  BASE: (ctx) => ctx.customPrices.get(ctx.listing.id) ?? ctx.listing.unit_price,
};

export const effectivePrice = (layer: PriceLayer, ctx: PriceCtx): number =>
  PRICE_RULE_EVALUATORS[layer.kind](ctx);
```

A new kind is a compile error in the `Record` until both the evaluator and the
precedence entry exist.

**Exemplar:** `LISTING_DEFAULT_FIELDS` with its per-field `appliesTo` predicate
replaced inline if/else chains — same shape, applied to price rules.

---

## 7. Edge compatibility error precedence as a data table

**Problem.** `edgeFieldError` (`listing-parents-rules.ts:77–98`) is a hand-coded
if-chain encoding a **strict precedence ordering**: parent-renewal >
child-renewal > daily-type > duration. The precedence lives only as the textual
order of the `if`s. Tests (`listing-parents-rules.test.ts:223–259`) re-derive
each pairwise relationship explicitly, and hardcode the full English error
strings (duplicating the i18n message). Adding a 5th edge rule is a fifth `if`
arm.

**Plan.** Model the edge rules as an ordered array of `{ check: (parent,
child) => boolean, messageKey: (name: string) => string }`. The fold returns
the first match (honouring precedence), or null:

```typescript
const EDGE_ERROR_RULES = [
  { applies: (p) => p.months_per_unit > 0, messageKey: (name) => t("listings_table.children_err_parent_renewal", { name }) },
  { applies: (_p, c) => c.months_per_unit > 0, messageKey: (name) => t("listings_table.children_err_child_renewal", { name }) },
  { applies: (_p, c) => c.listing_type === "daily" && p.listing_type !== "daily", messageKey: (name) => t("listings_table.children_err_child_daily", { name }) },
  { applies: (p, c) => !durationsCompatible(p, c), messageKey: (name) => t("listings_table.children_err_child_duration", { name }) },
] as const;

export const edgeFieldError = (parent, child) =>
  EDGE_ERROR_RULES.find(r => r.applies(parent, child))?.messageKey(child.name) ?? null;
```

The precedence tests can then assert against the table's ordering rather than
each pairwise relationship — and test that the table is exhaustive (every
check has a covering test).

**Exemplar:** `LISTING_DEFAULT_FIELDS` — an ordered array of entries each
carrying a predicate and a label key, folded by `resolveListingDefaults`. Same
shape, different domain.

---

## 8. Capacity rules — consolidate into one declarative reference

**Problem.** Capacity is the most scattered business concern. The rules live
across six files (booking/model.ts, capacity-tree.ts, package-cap.ts,
db/attendees/capacity.ts, db/capacity.ts, limits.ts) with no single declarative
table a reader can consult. The daily-vs-standard branching is enforced by
filtering listings out of certain queries rather than by a per-listing-type
rule table. Each rule is individually tested, but the interactions are
implicit.

**Plan.** This is the most complex item and may be staged:

- **Stage 1 — a `CAPACITY_RULES` data table** that declares, per listing-type
  facet (`daily` vs `standard`, `customisable_days` true/false), which capacity
  checks apply: `dateLessCap`, `perDateCap`, `groupPoolCap`,
  `parentChildUnits`, `adminOverbookBypass`. A pure `applicableCapacityRules
  (listing)` function returns the active rule set. This makes the daily-vs-
  standard branching explicit and additive rather than buried in `if`s.
- **Stage 2 — fold the JS preflight and the SQL guard** over the same rule set,
  so the invariant ("the JS preflight and the inline SQL must never disagree
  about capacity", `db/attendees/capacity.ts:1–9`) is enforced by sharing the
  declaration rather than by a comment.

**Exemplar:** The `BookingNode` union of facets (`booking/tree.ts:81–98`) is
the codebase's reference for modelling a domain as a typed data structure. A
capacity-rules table is a simpler version: a flat array of facets + an
`appliesTo` predicate per rule (mirroring `LISTING_DEFAULT_FIELDS`).

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

Items 1 and 3 are the highest-value starting points:

- **Item 1 (admin-page schema)** unlocks items 2, 4, and 8, and is the largest
  single reduction in duplicated knowledge. It is also the hardest.
- **Item 3 (limits unification)** is self-contained, small, and fixes a real
  bug (`MAX_IMAGE_SIZE` default mismatch).

Items 5, 6, 7, 9, and 10 are independent, medium-size refactors that can be
done in any order. Item 8 is the most complex and should be staged after the
admin-page schema exists (so read-only patterns can derive from it).

When taking any item, follow the codebase conventions: put the schema in
`src/shared/` (pure, data-in/data-out), keep the IO shell thin, and migrate
every caller in the same change. Run `deno task precommit` to verify.
