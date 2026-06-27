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

This is purely a **presentation** layer over the existing form. The DB schema,
the create/update resources (`src/features/admin/listings-form.ts`), validation,
and every stored field stay exactly as they are.

## Why this fits the existing model

Three pieces already in the codebase make this almost entirely additive:

- **Type is already derivable.** `isPaidListing(listing)`
  (`src/shared/types.ts:130`) answers "purchaseable?"; `listing_type === "daily"`
  answers "daily?"; `uses_logistics` answers "has logistics?"; a non-empty `date`
  answers "has a fixed date?". The four booleans the five types are defined by are
  all readable today with no new columns.

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

| Dimension   | Source field(s)                          | Meaning                                  |
| ----------- | ---------------------------------------- | ---------------------------------------- |
| `daily`     | `listing_type === "daily"`               | recurring per-date booking vs single     |
| `dated`     | `date` non-empty                         | has one fixed calendar date/time         |
| `paid`      | `isPaidListing(listing)`                 | has a price / pay-what-you-want / day prices |
| `logistics` | `uses_logistics`                         | delivery/collection agents assigned      |

The initial five types, as their dimension signatures:

| # | Type                  | `daily` | `dated` | `paid` | `logistics` |
| - | --------------------- | ------- | ------- | ------ | ----------- |
| 1 | One-off event ticket  | no      | **yes** | no     | no          |
| 2 | Weekly event ticket   | **yes** | —       | no     | no          |
| 3 | Online digital ticket | no      | no      | **yes**| no          |
| 4 | Delivered item        | no      | no      | **yes**| **yes**     |
| 5 | Bookable item         | **yes** | —       | **yes**| **yes**     |

`—` = not part of the signature: a daily listing books a date *per booking* and
ignores the listing-level `date` field (the CSS already hides `date` for daily
listings, `style.scss:1663`), so `dated` is only meaningful for standard listings.

### Mutual exclusivity

These signatures are pairwise disjoint, so a listing maps to **at most one**
type — which is exactly the "types must be mutually exclusive, but that's fine"
constraint. Reading the table:

- Standard (`daily=no`) splits cleanly by `(dated, paid, logistics)` into types
  1, 3, 4.
- Daily (`daily=yes`) splits cleanly by `paid` (with `logistics` tracking it)
  into types 2, 5.

Not every combination is named, and that is deliberate (see "The Custom
fallback").

### What each type shows vs. hides by default

The inferred type fixes the four dimensions, so the inputs that *set* those
dimensions — and their dependent fields — are the ones hidden behind Customise.
Grouping the existing fields:

- **`DAILY` group** — `listing_type`, `bookable_days`, `minimum_days_before`,
  `maximum_days_after`, `duration_days`, `customisable_days`, the day-prices
  fieldset. (Relevant only to daily types.)
- **`DATE` field** — `date`. (Relevant only to the one-off event.)
- **`PRICING` group** — `unit_price`, `can_pay_more`, `max_price`. (Relevant only
  to paid types.)
- **`LOGISTICS` field** — `uses_logistics`. (Relevant only to logistics types.)
- **Always shown** — `name`, `description`, `location`, `max_attendees`,
  `max_quantity`, `fields` (contact), `closes_at`, image/attachment.
- **Always behind Customise/Advanced** — `thank_you_url`, `webhook_url`,
  `non_transferable`, `purchase_only`, `hidden`, `slug`, builder fields. (These
  are already the rarely-touched fields; they fold into the same Customise
  region rather than a second separate one.)

| Type                  | Shown by default (beyond "always")        | Hidden behind Customise         |
| --------------------- | ----------------------------------------- | ------------------------------- |
| One-off event ticket  | `DATE`                                    | `DAILY`, `PRICING`, `LOGISTICS` |
| Weekly event ticket   | `DAILY`                                   | `DATE`, `PRICING`, `LOGISTICS`  |
| Online digital ticket | `PRICING`                                 | `DAILY`, `DATE`, `LOGISTICS`    |
| Delivered item        | `PRICING`, `LOGISTICS`                    | `DAILY`, `DATE`                 |
| Bookable item         | `DAILY`, `PRICING`, `LOGISTICS`           | `DATE`                          |

(The contact-fields hint matters for Delivered item — `address` is the field an
operator most wants there — but the contact group is always shown, so no special
casing; just default-check the relevant boxes in the template seed, below.)

---

## The Custom fallback

A listing whose `(daily, dated, paid, logistics)` does not match any of the five
signatures (e.g. a *standard, dated, paid* event — a real in-person ticket you
sell — or a *daily, free, logistics* hold) is **Custom**: no type matched, so we
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
export type FieldGroup = "DAILY" | "DATE" | "PRICING" | "LOGISTICS";

export type ListingTemplate = {
  id: string;                 // "one-off-event", "weekly-event", …
  label: string;             // picker card title (i18n key)
  description: string;       // picker card blurb (i18n key)
  // The dimension signature used BOTH to match an existing listing and to seed a
  // new one. `dated` omitted (—) where not part of the signature.
  signature: { daily: boolean; dated?: boolean; paid: boolean; logistics: boolean };
  shown: readonly FieldGroup[];   // groups revealed by default; the rest are hidden
  // Field values a freshly-picked template pre-fills on the blank create form.
  seed: Partial<FieldValues>;     // e.g. { listing_type: "daily" } or { fields: "email,address" }
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
  paid: isPaidListing(l),
  logistics: l.uses_logistics,
});
```

`matchesSignature` ignores `dated` when the signature omits it (daily types).
Reuse the existing `isPaidListing` rather than re-deriving "paid".

### 3. Override detection (edit path)

For the inferred template, a field group is *hidden* unless one of its fields
holds a non-default value. Generalise `advancedSectionHasValues`: a group is
**forced visible** when any field in it differs from its blank/default. Concretely
a "One-off event" that somehow has `unit_price > 0` keeps `PRICING` shown (and
Customise expanded), so the operator sees the price that makes it atypical instead
of it silently hiding. This is the rule from point 4 of the Goal, implemented as
"start Customise open + reveal the overridden group."

Defaults to compare against come from the schema defaults already in
`schema.ts:66-127` (e.g. `unit_price` null/0, `uses_logistics` 0, `date` `''`).

### 4. The Customise toggle (CSS, no JS)

Add a single `Customise` checkbox to the form. Each hideable section gets a class
(`listing-section--pricing`, `--logistics`, `--date`, reusing the existing
`--daily`), and the SCSS hides those sections **unless** Customise is checked,
extending the existing `hidden-in-form` mixin. The server decides the checkbox's
initial `checked` state and which section classes are present/hidden based on the
inferred template + overrides; from there the pure-CSS `:has()` reveal does the
rest live as the operator toggles it. This mirrors `.listing-advanced` and the
`hidden-when-selected` rules already in `style.scss:1637-1676`.

Because the daily-vs-standard and pay-more reveals are *already* CSS-driven by the
form's own selects, those keep working inside the revealed form unchanged — the
Customise toggle is an outer layer, not a replacement.

### 5. The type-picker create page

`GET /admin/listing/new` (`src/features/admin/listings-edit.ts:57`,
`adminListingNewPage` at `listings.tsx:1815`) changes from "render the full blank
form" to "render five cards + a Custom option," generated from `LISTING_TEMPLATES`
(same table, so the picker can never drift from the inference). Each card links to:

```
GET /admin/listing/new?template=<id>      // e.g. ?template=delivered-item
```

The same handler, given `?template=<id>`, renders the blank create form but:

- applies the template's `seed` values (`listing_type`, default contact fields,
  etc.) as the form's initial `values`,
- shows only the template's `shown` groups, with Customise collapsed — i.e. it
  renders **exactly as if a blank listing had been inferred as that type**. No new
  code path: feed the chosen template into the same "which groups are visible"
  logic the edit page uses (with no overrides, since the form is blank).
- `?template` absent or unknown, or `?template=custom`, → the current full form
  with Customise expanded (today's behaviour, preserved).

The param is **never persisted**. On submit it's an ordinary
`POST /admin/listing`; the created listing has no stored type, and reopening it
re-infers from its saved fields. (A "One-off event" picked at create that the
operator then gives a price to will simply re-infer as Custom next time — correct,
because that's no longer one of the five shapes.)

This also means **duplicate** (`adminDuplicateListingPage`, `listings.tsx:1861`)
needs no picker: it pre-fills from an existing listing, so it just runs inference
on that listing like the edit page.

---

## Files this touches

| Concern | File | Change |
| --- | --- | --- |
| Template table + inference + override helper | `src/shared/listing-templates.ts` (new) | The `LISTING_TEMPLATES` schema, `inferTemplate`, `dimensionsOf`, group-override detection. |
| Reuse "paid" / dimensions | `src/shared/types.ts` | None — `isPaidListing` already exported; consume it. |
| Form sectioning | `src/ui/templates/admin/listings.tsx` | Tag each hideable `<fieldset>` with a group class; drive section visibility + the Customise checkbox's initial state from the inferred template (edit/duplicate) or the `?template` seed (create); generalise `advancedSectionHasValues` into a per-group override check. |
| Create page → picker | `src/features/admin/listings-edit.ts` + `listings.tsx` (`adminListingNewPage`) | Render the picker from `LISTING_TEMPLATES` when no `?template`; render a seeded/collapsed blank form when `?template=<id>`. |
| Customise CSS | `src/ui/static/style.scss` | New section classes + a `reveal-when-checked`-style rule keyed off the Customise checkbox, alongside the existing `hidden-when-selected` block. |
| Copy | i18n files | Picker card titles/blurbs, the "Customise" label, per-type hints. |

No migration. No change to `listings-form.ts`, validation, the DB schema, or any
stored field. The detail page (`adminListingPage`) is unaffected — this is an
edit/create-form change only, though a future nicety could surface the inferred
type label on the detail page too (out of scope here).

---

## Testing (per AGENTS.md)

- **Inference is total and exclusive.** Table-driven test over all 16
  `(daily, dated, paid, logistics)` combinations: each of the five signatures
  maps to its one type, every other combination maps to `null` (Custom). This is
  the headline invariant — prove no listing ever matches two types.
- **Override surfaces a hidden field.** A listing whose inferred type hides
  `PRICING` but that has `unit_price > 0` renders with the pricing section visible
  and Customise expanded (assert on the rendered markup / the visibility flags,
  not internals). One test per group (DAILY/DATE/PRICING/LOGISTICS).
- **Picker → seeded form.** `GET /admin/listing/new?template=delivered-item`
  renders a blank form pre-seeded with `listing_type=standard`, pricing +
  logistics shown, daily + date hidden; `?template=custom` and an unknown value
  both render the full form. Assert the seeds and which sections are present.
- **Round-trips as a normal create.** A form submitted from a seeded picker form
  creates a listing with the expected stored fields and **no** type column (there
  is none); reopening it re-infers the same type.
- **CSS reveal is behavioural, not JS.** The Customise checkbox reveals hidden
  sections via `:has()` — covered by the existing form-render tests asserting the
  classes/markup are present (the visual reveal is CSS, like the daily/pay-more
  reveals today).
- Negative paths unchanged: existing listing validation tests still pass — this
  layer adds no new server-side acceptance.

Run `deno task precommit` (typecheck, lint, 0% cpd, tests) before finishing.
Consider `deno task mutation src/shared/listing-templates.ts` on the inference
predicate — an inverted or dropped dimension check is exactly the mutant that must
not survive.

---

## Open questions / decisions for the operator

1. **Standard + paid + dated.** A genuine in-person *paid* event with a fixed
   date (sell tickets to a gig on the 14th) doesn't match any of the five — it
   falls to Custom. Is that acceptable, or should there be a sixth "Paid event
   ticket" type? The five as given deliberately make "event = free, item = paid";
   confirm that's the intended split.
2. **Closes_at / registration deadline.** Currently always shown. It's arguably
   irrelevant to a Delivered item or Online digital ticket. Keep it always-shown
   for simplicity, or fold it into a group too?
3. **Contact-field seeds.** Delivered item wants `address`; Online digital wants
   only `email`. Should the template `seed` pre-tick those contact boxes (and the
   operator can change them), or leave contact fields untouched at defaults?
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
