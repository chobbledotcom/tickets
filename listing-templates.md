# Listing Templates — Planning Doc

> **Sketch / planning document.** Nothing here is built yet. This proposes a way
> to simplify the listing edit page by inferring a *type* from the fields a
> listing already has, hiding the irrelevant inputs behind a "Customise" toggle,
> and offering a type picker on create. There is **no new `type` column** — the
> type is always derived, never stored.

## Goal

The listing form has grown large: `getListingFields()`
(`src/ui/templates/fields.ts:345`) plus the logistics, builder, image, and slug
add-ons render ~25 inputs across five `<fieldset>` sections and an Advanced
`<details>` (`src/ui/templates/admin/listings.tsx:1642-1808`). Most listings only
ever use a handful of them; the rest are noise an operator has to scroll past and
mentally filter.

We want the page to feel like it asks only the questions that matter for *this
kind of thing*, the same way attendees split into "attendee" vs "servicing"
(`servicing.md`) — but **without** a discriminator column. Instead:

1. **Infer the type** from the values a listing already carries (daily? dated?
   purchaseable? logistics?).
2. **Hide the inputs irrelevant to that type** by default, behind a "Customise"
   checkbox that reveals the full form.
3. On **create**, show an intermediate **type-picker** page; choosing a type just
   adds a query param that pre-seeds the same inference (sensible defaults + the
   right inputs collapsed) — exactly as if the new blank listing had already been
   inferred as that type.
4. If, on **edit**, a listing has a value in a field its inferred type would
   normally hide (an override), that field is **not** hidden — it surfaces so the
   operator can see what makes this listing unusual.

This is almost entirely a **presentation** layer over the existing form: the DB
schema, the create/update resources (`src/features/admin/listings-form.ts`), and
every stored field stay exactly as they are. The **one** server-side addition is a
single template-specific validation — the one-off template requires a `date` (see
§5 and "Files this touches") — so a one-off can't silently save a blank date and
reopen as Custom. Everything else, including all existing validation, is unchanged.

## Why this fits the existing model

Three pieces already in the codebase make this almost entirely additive:

- **Type is already derivable.** `purchase_only` (the "No check-in" box) answers
  "purchaseable?"; `listing_type === "daily"` answers "daily?"; `uses_logistics`
  answers "has logistics?"; a non-empty `date` answers "has a fixed date?". The
  four booleans the five types are defined by are all stored fields readable today
  with no new columns.

- **Conditional visibility is already pure CSS.** The form hides daily-only
  fields, the day-prices block, the max-price field, etc. entirely through
  `:has()` selectors driven by the form's own inputs — see the
  `hidden-when-selected` / `reveal-when-checked` / `hidden-in-form` mixins in
  `src/ui/static/style.scss:1637-1676`. The "Customise" toggle is the same
  mechanism: one more checkbox whose checked state reveals the hidden sections,
  no JavaScript required.

- **"Reveal when a value is set" is already a pattern.** `advancedSectionHasValues`
  (`src/ui/templates/admin/listings.tsx:1691`) opens the Advanced `<details>`
  on edit whenever any advanced field carries a value, so a configured webhook is
  never hidden. The override rule (point 4 above) is the same idea generalised:
  start the Customise section open whenever an inferred-hidden field holds a
  non-default value.

So the work is: a declarative template table, a small inference function, a
type-picker create page, and wiring the form sections + CSS to a "Customise"
toggle. No migration, no data-layer change.

---

## The five types

Each type is a fixed point in four dimensions:

| Dimension      | Source field(s)            | Meaning                                  |
| -------------- | -------------------------- | ---------------------------------------- |
| `daily`        | `listing_type === "daily"` | recurring per-date booking vs single     |
| `dated`        | `date` non-empty           | has one fixed calendar date/time         |
| `purchaseable` | `purchase_only`            | the **"No check-in"** box — a pure e-ticket / purchase with no door check-in, vs an event you scan people into |
| `logistics`    | `uses_logistics`           | delivery/collection agents assigned      |

**Price is *not* a dimension.** "Purchaseable" here means the existing
`purchase_only` toggle ("No check-in mode", `schema.ts` / the `purchase_only`
field at `fields.ts:538`), **not** whether the listing has a price. A listing of
any type can have a price; pricing stays an orthogonal, always-available field.

The initial five types, as their dimension signatures:

| # | Type                  | `daily` | `dated` | `purchaseable` | `logistics` |
| - | --------------------- | ------- | ------- | -------------- | ----------- |
| 1 | One-off event ticket  | no      | **yes** | no             | no          |
| 2 | Weekly event ticket   | **yes** | —       | no             | no          |
| 3 | Online digital ticket | no      | no      | **yes**        | no          |
| 4 | Delivered item        | no      | no      | **yes**        | **yes**     |
| 5 | Bookable item         | **yes** | —       | **yes**        | **yes**     |

`—` = not part of the signature: a daily listing books a date *per booking* and
ignores the listing-level `date` field (the CSS already hides `date` for daily
listings, `style.scss:1663`), so `dated` is only meaningful for standard listings.

### Mutual exclusivity

These signatures are pairwise disjoint, so a listing maps to **at most one**
type — which is exactly the "types must be mutually exclusive, but that's fine"
constraint. Reading the table:

- Standard (`daily=no`) splits cleanly by `(dated, purchaseable, logistics)` into
  types 1, 3, 4.
- Daily (`daily=yes`) splits cleanly by `purchaseable` (with `logistics` tracking
  it) into types 2, 5.

Not every combination is named, and that is deliberate (see "The Custom
fallback"). Because `purchaseable` is a stored boolean (`purchase_only`) rather
than a derived "has a price" predicate, each type's signature is **fully
determined by four real stored fields the seed can set directly** — there is no
"did the operator also enter a price?" ambiguity (see the create-seed note in §5).

### What each type shows vs. hides by default

The inferred type fixes the four dimensions, so the **toggles that set those
dimensions** are hidden behind Customise (the type already decided them), while
the **configuration each type still needs** stays visible. Three kinds of field:

- **Dimension toggles — hidden once a type is set** (the type fixes them):
  - `listing_type` (daily vs standard),
  - `purchase_only` (the "No check-in" box — the `purchaseable` dimension),
  - `uses_logistics` (the `logistics` dimension).
- **Type-dependent configuration — shown only when its type needs it:**
  - **`DAILY` group** — `bookable_days`, `minimum_days_before`,
    `maximum_days_after`, `duration_days`, `customisable_days`, the day-prices
    fieldset. Shown for daily types (2, 5) — the operator still picks *which*
    days, the booking window, and durations.
  - **`DATE` field** — `date`. Shown only for the one-off event (type 1).
- **Orthogonal — always shown for every type:** `name`, `description`,
  `location`, `max_attendees`, `max_quantity`, `fields` (contact), `closes_at`,
  **pricing** (`unit_price`, `can_pay_more`, `max_price`), image/attachment.
  Pricing is here, not in a group: price is independent of the four dimensions,
  so any type may have one.
- **Always behind Customise/Advanced** — `thank_you_url`, `webhook_url`,
  `non_transferable`, `hidden`, builder fields, and `slug`. These already live in
  the Advanced `<details>` (`non_transferable`/`hidden` are in the Options section
  today, the rest in Advanced); they fold into the same Customise region.
  **They keep the non-default surfacing rule (§3):** a listing that is `hidden`,
  `non_transferable`, or has a configured webhook renders with that field visible
  (Customise expanded), so collapsing never buries state an operator set — exactly
  as `advancedSectionHasValues` already forces the Advanced section open today.
  **`slug` is excluded from the surfacing rule** (it is auto-generated and always
  non-empty on edit, so it would force Customise open on every listing —
  `advancedSectionHasValues` already excludes it for the same reason).

| Type                  | Shown beyond "always"     | Hidden toggles + groups                          |
| --------------------- | ------------------------- | ------------------------------------------------ |
| One-off event ticket  | `DATE`                    | all 3 toggles, `DAILY`                            |
| Weekly event ticket   | `DAILY`                   | all 3 toggles, `DATE`                             |
| Online digital ticket | —                         | all 3 toggles, `DAILY`, `DATE`                    |
| Delivered item        | —                         | all 3 toggles, `DAILY`, `DATE`                    |
| Bookable item         | `DAILY`                   | all 3 toggles, `DATE`                             |

(Online digital and Delivered item differ only in the hidden `uses_logistics`
toggle, so they show the same fields — the type is still distinct because the
seed sets `uses_logistics` differently. The contact-fields box matters for
Delivered item — `address` — but contact fields are always shown, so the template
seed just default-ticks the right boxes; see §5.)

---

## The Custom fallback

A listing whose `(daily, dated, purchaseable, logistics)` does not match any of
the five signatures (e.g. a *standard, no-date, check-in, logistics* item, or a
*daily, purchaseable, no-logistics* listing) is **Custom**: no type matched, so we
hide nothing and render the full form with Customise already expanded. The picker
page offers an explicit **"Custom / advanced"** option that does the same on
create. This keeps the five types small and opinionated without ever trapping a
listing that doesn't fit them.

Note the five named types cover the *common* shapes, not the whole 16-cell space;
the Custom path is what makes "mutually exclusive named types" safe — anything
unnamed degrades gracefully to the current full-form experience.

---

## Mechanism

### 1. A declarative template table (schema over organic structure)

Per the AGENTS.md "schema over organic structure" preference, model the five
types as data and derive *everything* (the picker page, the inference function,
the seed defaults, the hidden-field sets) from one table — rather than hand-wiring
each. Sketch:

```ts
// src/shared/listing-templates.ts
export type FieldGroup = "DAILY" | "DATE";   // the only type-dependent config groups

export type ListingTemplate = {
  id: string;                 // "one-off-event", "weekly-event", …
  label: string;             // picker card title (i18n key)
  description: string;       // picker card blurb (i18n key)
  // The dimension signature used BOTH to match an existing listing and to seed a
  // new one. `dated` omitted (—) where not part of the signature.
  signature: { daily: boolean; dated?: boolean; purchaseable: boolean; logistics: boolean };
  shown: readonly FieldGroup[];   // config groups revealed by default; dimension toggles always hidden
  // Field values a freshly-picked template pre-fills on the blank create form.
  // CRITICAL: the seed sets every dimension field that is a stored boolean/enum —
  // listing_type, purchase_only, uses_logistics — so the saved row re-infers as
  // this template. It does NOT seed `date`: the one-off's `dated=true` can't be
  // pre-filled with a sensible value, so that template instead makes `date`
  // *required* (see §5 and the validation note in "Files this touches").
  seed: Partial<FieldValues>;     // e.g. { listing_type: "daily", purchase_only: "1", uses_logistics: "1" }
  // Whether this template needs the logistics feature (logistics:true ⇒ only
  // offered/usable when settings.hasLogistics; see §5).
  requiresLogistics: boolean;
  // Whether the create form must require a `date` for this template (one-off only)
  // — the only template-specific validation this feature adds.
  requiresDate: boolean;
};

export const LISTING_TEMPLATES: readonly ListingTemplate[] = [ /* the 5 */ ];
```

The `shown` list is the complement of the "Hidden behind Customise" column above;
deriving one from the other keeps them in sync.

### 2. Inference (edit path)

A pure function maps a stored listing to a template id or `null` (Custom):

```ts
// src/shared/listing-templates.ts
export const inferTemplate = (l: Listing): ListingTemplate | null =>
  LISTING_TEMPLATES.find((t) => matchesSignature(t.signature, dimensionsOf(l))) ?? null;

const dimensionsOf = (l: Listing) => ({
  daily: l.listing_type === "daily",
  dated: l.date !== "",
  purchaseable: l.purchase_only,        // the "No check-in" box, not a price check
  logistics: l.uses_logistics,
});
```

`matchesSignature` ignores `dated` when the signature omits it (daily types). All
four dimensions read directly off stored boolean/enum fields — no derived "has a
price" predicate, so inference can never disagree with what the seed wrote.

### 3. Override detection (edit path)

A *normally-hidden* field is **forced visible** (Customise expanded) when the
listing deviates from **what its inferred template implies** — generalising
`advancedSectionHasValues`. Getting the *baseline of comparison* right is the
whole subtlety here; "non-default" is too naive in three ways:

1. **Exclude the dimension toggles entirely.** `listing_type`, `purchase_only`,
   and `uses_logistics` are hidden *because the type fixed them* — and they are
   non-default precisely when they matched (a Bookable item has
   `purchase_only=1`, `uses_logistics=1`, `listing_type=daily`). Comparing them to
   a blank default would force Customise open on every matched template. They are
   never overrides: inference already consumed them, so the override check skips
   them. (A toggle that *didn't* match would have produced a different template or
   Custom, not an override.)

2. **Compare config-group fields to their persisted (DB/create-parsing) defaults,
   not a blank form default.** The hidden `DAILY` group is the trap: every saved
   listing — even a standard one-off — carries the daily column defaults
   (`bookable_days` = all seven days, `minimum_days_before=1`,
   `maximum_days_after=90`, `duration_days=1`; `schema.ts`). Those are "untouched"
   values, not overrides. So the baseline for a hidden field is the value a
   listing that *only ever used this template* would hold — i.e. the schema /
   create-parsing default — and only a deviation from **that** surfaces the group.
   Likewise `max_price` defaults to `100.00` (`fields.ts:493`) and is persisted
   even when `can_pay_more` is off, so it must be ignored unless `can_pay_more` is
   set. (Pricing is always shown anyway, so `max_price` doesn't drive a template
   override — but the persisted-default principle is the rule for whatever the
   Customise region collapses.)

3. **Exclude `slug`.** Auto-generated and always non-empty on edit, so it would
   surface on every listing; `advancedSectionHasValues` already excludes it.

Net rule: **override = a hidden field that is neither one of the three dimension
toggles (`listing_type`/`purchase_only`/`uses_logistics`) nor `slug`, whose stored
value differs from the value the inferred template's seed + schema defaults would
have produced.** Note the exclusion is the three **toggles**, *not* every field
the signature touches: `date` is the `dated` dimension but it is **not** excluded —
a daily listing carrying a listing-level `date` is exactly the override that must
surface (the `date` group reveals, Customise opens). That keeps the common case (a
listing that matches a template cleanly) fully collapsed, and only pops Customise
for the genuinely unusual field — a daily listing with a stray `date`, a one-off
with a webhook, a `hidden` flag, etc.

### 4. The Customise toggle (CSS, no JS)

Add a single `Customise` checkbox to the form. Each hideable section/field gets a
class (`listing-section--daily`, `--date`, and the dimension-toggle wrappers), and
the SCSS hides those **unless** Customise is checked, extending the existing
`hidden-in-form` mixin. The server decides the checkbox's initial `checked` state
and which classes are present based on the inferred template + overrides; from
there the pure-CSS `:has()` reveal does the rest as the operator toggles it. This
mirrors `.listing-advanced` and the `hidden-when-selected` rules already in
`style.scss:1637-1676`.

**Customise must win over the existing daily/date hiding rules.** The current CSS
hides the `date` label whenever `listing_type=daily` is selected
(`style.scss:1663`) and hides `duration_days` for standard-without-customisable
(`:1657`). Those rules are unconditional, so an override that wants to *surface*
`date` on a daily listing (a daily row that somehow has a listing-level date set)
would still be hidden by the older selector. The new rules must therefore be
**layered so a checked Customise state overrides** the daily/date/duration hides —
e.g. scope those existing hides with `:not(:has(<customise-checkbox>:checked))`,
so expanding Customise reveals everything regardless of the daily/standard
selection. Without this layering the override rule is silently defeated for the
date and duration fields.

### 5. The type-picker create page

`GET /admin/listing/new` (`src/features/admin/listings-edit.ts:57`,
`adminListingNewPage` at `listings.tsx:1815`) changes from "render the full blank
form" to "render five cards + a Custom option," generated from `LISTING_TEMPLATES`
(same table, so the picker can never drift from the inference). Each card links to:

```
GET /admin/listing/new?template=<id>      // e.g. ?template=delivered-item
```

The same handler, given `?template=<id>`, renders the blank create form but:

- applies the template's `seed` values as the form's initial `values`. **The seed
  must set every dimension field the signature pins** — `listing_type`,
  `purchase_only`, `uses_logistics` — so that submitting the form unchanged saves a
  row that re-infers as this exact template. Because those dimensions are stored
  booleans the seed writes directly (not a derived "has a price"), there's no
  "operator forgot to add a price → reopens as Custom" trap: an Online digital
  ticket persists `purchase_only=1` and re-infers correctly whether or not a price
  was entered.
  - **The one-off event is the exception: its signature includes `dated=true`,
    which can't be pre-seeded with a sensible value.** A date isn't a boolean to
    flip — it's the operator's actual event date — so the seed can't supply it.
    For this template the create form therefore makes `date` **required** (it's
    inherent: "a one-off event *has* a date"), so a saved one-off always carries
    `date !== ""` and re-infers correctly. The "unchanged submit round-trips"
    promise holds for the other four templates unconditionally; for the one-off it
    holds *given* the required date the operator must enter (a blank-date submit is
    rejected by validation before it can save a `dated=false` row, so it never
    silently reopens as Custom).
- shows only the template's `shown` config groups, with Customise collapsed — i.e.
  it renders **exactly as if a blank listing had been inferred as that type**. No
  new code path: feed the chosen template into the same "which fields are visible"
  logic the edit page uses (with no overrides, since the form is blank).
- **The seed also pre-fills the *visible* config defaults a daily template
  exposes.** For Weekly/Bookable the `DAILY` group is shown, but those controls
  (`bookable_days`, `minimum_days_before`, `maximum_days_after`, `duration_days`)
  render blank on a fresh form while create-parsing only *falls back* to
  all-days / `1` / `90` / `1` on a blank submit. So the daily templates' `seed`
  must set those four to their create-parsing defaults too — otherwise the
  operator sees empty daily settings while an unchanged submit silently saves the
  non-empty fallbacks (a confusing "what did I just save?" gap). General rule: the
  seed pre-fills every value a shown control would otherwise render blank but that
  create-parsing would default on save, so the form always shows what it will
  store. (The dimension toggles are seeded for inference; these visible daily
  defaults are seeded for honesty.)

**Routing of the GET (resolving the picker/form ambiguity):**

| URL | Renders |
| --- | --- |
| `GET /admin/listing/new` (no `?template`) | the **card picker** |
| `GET /admin/listing/new?template=<known id>` | the seeded, Customise-collapsed form |
| `GET /admin/listing/new?template=custom` | the full form, Customise expanded |
| `GET /admin/listing/new?template=<unknown>` | treat as `custom` (full form) |

So the bare `/new` URL is always the picker; the full default form is reached only
via the explicit Custom card. (Earlier draft wording said an absent param renders
the full form — that contradicts the picker and is corrected here.)

**Logistics-gated templates.** When `settings.hasLogistics` is false, the create
form omits `logisticsField` and create-parsing won't persist `uses_logistics`
(`listings.tsx:1824`), so Delivered item and Bookable item could not save their
`logistics=yes` signature — they'd reopen as a different/Custom type. So the
picker **hides** (or disables, with an explanatory note) any template whose
`requiresLogistics` is true unless logistics is enabled, and the seeded-form
handler rejects such a `?template` the same way. Symmetric to how the form already
only renders logistics when the feature is on.

**Carry the template through POST validation errors.** The seeded form posts to
the ordinary `POST /admin/listing`, whose error path currently re-renders via
`adminListingNewPage(groups, session, result.error)` (`listings-edit.ts:77`) with
no idea which card was chosen — so a validation failure would drop the operator
back to the picker/full form, losing the seeded/collapsed context and their
entered values. Carry the chosen template id through the submit (a hidden
`template` input in the form, or a `?template=<id>` on the POST action) and have
the error path re-render the **same seeded/collapsed form** with the submitted
values + error. The id is read only to pick the render shape; it is **never
written to the listing row**.

The param is **never persisted**. On a successful submit it's an ordinary create;
the created listing has no stored type, and reopening it re-infers from its saved
fields.

This also means **duplicate** (`adminDuplicateListingPage`, `listings.tsx:1861`)
needs no picker: it pre-fills from an existing listing, so it just runs inference
on that listing like the edit page.

---

## Files this touches

| Concern | File | Change |
| --- | --- | --- |
| Template table + inference + override helper | `src/shared/listing-templates.ts` (new) | The `LISTING_TEMPLATES` schema, `inferTemplate`, `dimensionsOf`, group-override detection. |
| Dimensions source | `src/shared/types.ts` / schema | None — `purchase_only`, `listing_type`, `uses_logistics`, `date` are all stored fields read directly. |
| Form sectioning | `src/ui/templates/admin/listings.tsx` | Tag each hideable field/`<fieldset>` with a class; drive visibility + the Customise checkbox's initial state from the inferred template (edit/duplicate) or the `?template` seed (create); generalise `advancedSectionHasValues` into a per-field override check that compares against the template's seed + persisted defaults and excludes the dimension toggles and `slug` (§3). |
| Create page → picker | `src/features/admin/listings-edit.ts` + `listings.tsx` (`adminListingNewPage`) | Picker when no `?template`; seeded/collapsed form for a known `?template`; gate `requiresLogistics` templates on `settings.hasLogistics`; carry the template id through POST error re-renders. |
| Customise CSS | `src/ui/static/style.scss` | New classes + a Customise-checkbox reveal, **layered to override** the existing daily/date/duration hides (scope those with `:not(:has(customise:checked))`). |
| Copy | i18n files | Picker card titles/blurbs, the "Customise" label, per-type hints. |

No migration, no DB-schema change, no change to any stored field. The **one**
server-side addition is a template-specific **required-`date` validation for the
one-off template** (the create handler must reject a blank `date` when the chosen
`?template` is the one-off, so it can't save a `dated=false` row that reopens as
Custom — see §5). Everything else in `listings-form.ts` validation is unchanged.
The detail page (`adminListingPage`) is unaffected — this is otherwise an
edit/create-form change only, though a future nicety could surface the inferred
type label on the detail page too (out of scope here).

---

## Testing (per AGENTS.md)

- **Inference is total and exclusive.** Table-driven test over all 16
  `(daily, dated, purchaseable, logistics)` combinations. **Mind the `dated`
  asymmetry:** because `dated` is ignored for daily signatures, Weekly and Bookable
  each match *both* their `dated` states, so **7 of the 16 combinations map to a
  named type** (One-off ×1, Online digital ×1, Delivered ×1, Weekly ×2, Bookable
  ×2) and the remaining 9 map to `null` (Custom). The test must assert exactly this
  — a naive "only 5 combinations match, the other 11 are Custom" would wrongly
  require a daily listing that carries a listing-level `date` to be Custom, when it
  should infer Weekly/Bookable and surface the stray date as an *override*. Prove
  no combination matches two types. Include a *price does not affect type* case:
  the same `(standard, dated, not-purchase-only, no-logistics)` listing infers
  One-off whether `unit_price` is 0 or non-zero.
- **Override surfaces a hidden field — and ordinary listings stay collapsed.** Two
  sides:
  - A listing whose inferred type collapses a field but that *deviates from the
    template baseline* (e.g. `hidden`, `non_transferable`, a `webhook_url`, or a
    daily listing carrying a listing-level `date`) renders with that field visible
    and Customise expanded.
  - The negative case is the one that actually protects the feature: a *clean*
    listing of each template (carrying only the persisted daily defaults
    `bookable_days`=all / `min=1` / `max=90` / `duration=1`, an auto-generated
    `slug`, the matched dimension toggles, and `max_price=100.00` with
    `can_pay_more` off) renders **fully collapsed** — none of those count as
    overrides. This asserts the dimension-toggle / persisted-default / slug
    exclusions from §3 actually hold, so Customise isn't open on every listing.
- **Picker → seeded form.** `GET /admin/listing/new?template=delivered-item`
  renders a blank form pre-seeded with `listing_type=standard`, `purchase_only=1`,
  `uses_logistics=1`, daily + date hidden, Customise collapsed; `?template=custom`
  and an unknown value render the full form; **bare `/new` renders the picker**.
- **Daily templates seed their visible defaults.**
  `GET /admin/listing/new?template=weekly-event` renders the (visible) `DAILY`
  controls already filled with `bookable_days`=all / `min=1` / `max=90` /
  `duration=1` — not blank — so the rendered form matches what an unchanged submit
  would persist (no silent "form shows empty, save fills defaults" gap).
- **Logistics gating.** With `settings.hasLogistics=false`, the picker omits
  Delivered item + Bookable item, and `?template=delivered-item` does not render a
  seeded form that can't be saved.
- **Template survives a POST error.** A seeded `delivered-item` submit that fails
  validation re-renders the *same* seeded/collapsed form with the entered values
  and the error — not the picker or the default full form.
- **Round-trips as a normal create.** A form submitted unchanged from each seeded
  picker form creates a listing with the dimension fields set, and reopening it
  re-infers the **same** template (the key regression against the "reopens as
  Custom" failure mode). For the one-off, include both that a blank-date submit is
  *rejected* (date required) and that a submit *with* a date round-trips to One-off
  — proving it can never silently save a `dated=false` row that reopens as Custom.
- **CSS reveal is behavioural, not JS.** The Customise checkbox reveals hidden
  sections via `:has()`, and a checked Customise overrides the daily/date hides —
  covered by form-render tests asserting the classes/markup and the
  `:not(:has(...))` layering are present.
- Negative paths unchanged: existing listing validation tests still pass — this
  layer adds no new server-side acceptance.

Run `deno task precommit` (typecheck, lint, 0% cpd, tests) before finishing.
Consider `deno task mutation src/shared/listing-templates.ts` on the inference
predicate — an inverted or dropped dimension check is exactly the mutant that must
not survive.

---

## Open questions / decisions for the operator

1. **Unnamed combinations.** With `purchaseable = purchase_only` (not price), the
   9 uncovered shapes (of 16) that fall to Custom include e.g. *standard + no-date
   + check-in + logistics*, *daily + purchaseable + no-logistics*, and *standard +
   dated + purchaseable* (a dated item you sell). Is Custom acceptable for these,
   or does any deserve its own named type? (Pricing is orthogonal now, so a paid
   in-person dated event is just a One-off event ticket — that earlier gap is
   gone. Note *daily + check-in + no-logistics* is **not** uncovered — that is the
   Weekly event ticket.)
2. **Closes_at / registration deadline.** Currently always shown. It's arguably
   irrelevant to a Delivered item or Online digital ticket. Keep it always-shown
   for simplicity, or fold it into a group too?
3. **Contact-field seeds (resolved as a default; flag if you disagree).** To avoid
   a Delivered item silently not collecting a delivery address, the plan **decides**
   the Delivered item seed ticks `address` (alongside `email`) rather than leaving
   it to the operator to notice — consistent with the §"what each type shows" note.
   Online digital seeds `email` only. The seed is still operator-editable on the
   form; the question for you is only whether these *default* tick-sets are right,
   not whether to seed at all.
4. **Surfacing the inferred type.** Should the inferred type label show on the
   listing **detail** page and the listings table (read-only, "Type: Bookable
   item"), or stay purely an edit-form affordance? Showing it makes the inference
   visible/debuggable to operators (the "malleable software" preference) but is
   extra surface.
5. **Naming.** "Weekly event ticket" is really "daily/recurring, free" — it isn't
   necessarily weekly. Is "Weekly event" the label you want operators to see, or
   something like "Recurring event"?
6. **Customise granularity.** One master Customise toggle that reveals *all*
   hidden groups at once (simplest), or per-group reveals? Recommendation: one
   toggle — it matches the single Advanced `<details>` today and keeps the CSS
   trivial.
