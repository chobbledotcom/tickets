# Admin surface unification plan

## Status

Approved. Slices 1 and 2 are built. Slice 3 is built for the shared frameworks
and checked for everything else. What is left is named in
[What remains](#what-remains). See [What is built](#what-is-built) for the map
from this plan to the code, and
[The shortlist](#the-shortlist--other-rooms-the-survey-found) for the survey
behind it.

The built code is the authority for the parts that shipped. This document now
points at them; it does not describe them a second time.

## What is built

| Piece                    | Where it lives now                              |
| ------------------------ | ----------------------------------------------- |
| The one declaration      | `src/shared/admin-surface/areas.ts`             |
| Types and the fold       | `src/shared/admin-surface/definitions.ts`       |
| Ids and path parameters  | `src/shared/admin-surface/ids.ts`               |
| Navigation and its order | `src/shared/admin-surface/sections.ts`          |
| The derived surface      | `src/shared/admin-surface.ts`                   |
| Navigation model         | `src/shared/admin-pages.ts`                     |
| Gates from a route       | `src/features/auth.ts`                          |
| Route tables from a path | `src/features/admin/route-tables.ts`            |
| One CRUD factory         | `src/features/admin/crud-handlers.ts`           |
| Entity pages             | `src/features/admin/entity-pages.ts`            |
| The backwards check      | `test/integration/admin-role-matrix.test.ts`    |
| The forwards check       | `test/integration/admin-route-manifest.test.ts` |

Deleted with slice 1: `admin-surface/nav-routes.ts`,
`admin-surface/write-routes-a-m.ts`, `admin-surface/write-routes-n-z.ts`, and
the hand-written `ADMIN_SURFACE_AREAS` map. Deleted with slice 3:
`createOwnerCrudHandlers`, `createContentCrudHandlers`, the `guard` and
`basePath` fields on every entity page, and the `staffOnlyDetail` flag on a
navigation section.

Two things differ from what this plan first proposed:

- **Sections own their navigation order.** The plan grouped routes by area but
  did not say what happens to navigation order, which used to be the position of
  an entry in a 383-line file. Grouping by area destroys that order, because one
  section draws its links from up to sixteen areas. Each section now names its
  own links in order, so the order is a stated fact rather than a side effect of
  where a line sits.
- **A route no longer carries a section.** All 111 routes declared one, but only
  the 42 with a navigation link ever read it. It is gone from the other 69.

### What the backwards check found

`deliveries` declared `STAFF_ADMIN_LEVELS`, but `GET /admin/deliveries` is gated
by `deliveryPage`, which admits agents — and its own comment calls the run sheet
"their only page". An agent could open the page while the surface said they
could not, so `adminDestinationAllowed` gave the wrong answer for every link to
it.

The declaration was corrected to `DELIVERY_ADMIN_LEVELS`, which is the one place
that fact now lives. This is the "stricter side wins" default being overruled on
purpose: the strict reading would take the run sheet away from the agents it was
built for. No access changed — only the answer the surface gives about it.

## The search that led here

The job was to find one sweeping change that removes repetitive structure and
adds to the longevity of the system. jscpd already holds token duplication at
0%, so the repetition that remains is shape-level: one fact declared more than
once, in different words. Five sweeps covered the route layer, the database
layer, the templates, the payment providers, and the other shared modules.

The winner is the admin surface. It is the one place where the system keeps a
complete, hand-made map of itself — and nothing ties the map to the territory.

## Current-system value

Today one admin route's path, role, and area are declared in up to six files,
and only a test polices their agreement. After this change, each fact is
declared once, and every consumer derives from that declaration. The production
consumers are:

- `/admin/*` route dispatch (`src/features/admin/index.ts`);
- the admin navigation and links (`src/shared/admin-pages.ts`,
  `src/shared/admin-surface.ts`);
- read-only gates (`readOnlyGetRoutePatterns`).

## The duplication this replaced

This is the state slice 1 replaced, kept as the evidence for the change. Before
it, `src/shared/admin-surface/` was a shadow map of the admin surface: 111
destinations, each with a path pattern, a role audience, an area, a section, and
a read/write intent, while the real route tables in `src/features/admin/*`
repeated the same facts.

| File                                           | Lines | What it restates                                   |
| ---------------------------------------------- | ----- | -------------------------------------------------- |
| `src/shared/admin-surface/definitions.ts`      | 177   | 43 areas → segments, plus the destination builders |
| `src/shared/admin-surface/nav-routes.ts`       | 383   | 42 view destinations: pattern + audience + nav     |
| `src/shared/admin-surface/write-routes-a-m.ts` | 344   | 48 write destinations: pattern + audience          |
| `src/shared/admin-surface/write-routes-n-z.ts` | 155   | 21 write destinations: pattern + audience          |
| `src/features/admin/area-loaders.ts`           | 319   | the same 43 areas again → lazy import + messages   |
| `src/features/admin/*` route tables            | —     | the same patterns again, as route keys             |
| handler guards (`withAuth`, `requireOwnerOr`…) | —     | the same roles again, as auth policies             |

Three measured symptoms:

1. **The role is declared twice, with no check.** The surface tables state an
   audience 121 times (54 `OWNER_AUDIENCE`, 33 `STAFF_ADMIN_LEVELS`, 18
   `SITE_ADMIN_LEVELS`, 16 `CONTENT_ADMIN_LEVELS`). Each handler states its
   policy again (`OWNER_FORM`, `AUTH_FORM`, …). The `OWNER_API` policy carries a
   comment that admits the agreement is manual: "Keeps the JSON API
   authorization aligned with the UI so a manager cannot perform via the API
   what the dashboard denies them" (`src/features/auth.ts`). Nothing enforces
   that promise for any of the 111 destinations.
2. **A 125-line test exists only to police the drift.**
   `test/integration/admin-route-manifest.test.ts` loads every area and checks
   that segments, routes, and destinations still agree. The test is a direct
   measurement of the risk: without the duplication, most of it has nothing to
   police.
3. **One worked example — `/admin/holidays` declares its facts in six places.**
   The paths: `crudRoutes("/admin/holidays", …)` and
   `entityTabRoutes("/admin/holidays", …)` (`src/features/admin/holidays.ts`),
   `basePath` and `navActive` (`src/features/admin/holiday-page.ts`), and the
   patterns again in `nav-routes.ts` and `write-routes-a-m.ts`. The owner role:
   once in `createOwnerCrudHandlers`, once in `requireOwnerOr`, and three times
   as `OWNER_AUDIENCE`. The area: once in `ADMIN_SURFACE_AREAS`, once in
   `ADMIN_AREA_LOADERS`.

The two 43-entry area maps (`ADMIN_SURFACE_AREAS` and `ADMIN_AREA_LOADERS`)
exist apart for one good reason: the surface must be readable without an import
of any handler module, because handlers load lazily per segment. The design
below keeps that property.

## Behavior contract

### Trusted facts

- The route tables in `src/features/admin/*` are the observed authority for
  which method/path pairs exist. The manifest test loads them to know.
- The auth policy at each handler is the observed authority for who can act.
- The surface tables are the expected map of both. Today nothing makes the
  expected map match the observed facts except the manifest test and care.

This plan turns the expected map into the single source, so the observed facts
derive from it and cannot drift.

### Valid states

Compile-time only, because no stored data changes. Every route must carry an id,
an area, a pattern, an audience, and an intent; a route reached from the
navigation also carries its link. The loader map stays an exhaustive
`Record<AdminAreaId, …>`, so an area without a loader entry, or a loader without
an area, does not compile.

### Commands and events

None. The change adds no runtime command. Route dispatch, authentication, and
responses keep their current behaviour, except where an audience and a policy
disagree today (see Security and privacy).

### Failure table

None at runtime. The failures this plan targets move to compile time or to
module wiring: a destination without a handler, a route without a declared
segment, an area without a loader.

### Retry and replay table

None. The change adds no write and no external call.

### Concurrency table

None. The declarations are immutable module-load data, as the current tables
are.

### Owner choices

None for operators. For the human reviewer: every audience↔policy disagreement
the migration surfaces is listed in its pull request for an explicit decision.
The stricter side is the proposed default. No disagreement is resolved silently.

### Security and privacy

- Who can perform each action does not change by design. Where the declared
  audience and the enforced policy disagree today, that disagreement is exactly
  the bug class this plan removes. Each found case gets an explicit fix and a
  regression test.
- The navigation already shows a destination only when the viewer's level is in
  the audience. The role matrix proves that the declared audience and the gate
  the handler enforces agree for the 48 pages whose pattern takes no parameter,
  so a rendered link to one of those cannot outrun its target. The 63 pages for
  one record are not covered: a missing record answers 404 whatever the role is,
  so each needs a fixture, which is the first step of Slice 3. After Slice 3 the
  declared audience builds the gate as well, which makes the "never render a
  dead or forbidden link" rule mechanical for the whole admin surface rather
  than checked for part of it.
- No secret or personal field moves. No new untrusted input reaches the
  database.

## The shared contract — target design

One declaration per area, in one eager, pure-data module:

```typescript
// src/shared/admin-surface/areas.ts
export const ADMIN_AREAS = defineAdminAreas({
  holidays: {
    section: "settings",
    audience: OWNER_AUDIENCE,
    segments: ["holidays"],
    destinations: {
      holidays: { pattern: "/admin/holidays", nav: link("nav.holidays") },
      holidayNew: { pattern: "/admin/holidays/new", intent: "write-form" },
      holidayEdit: {
        pattern: "/admin/holidays/:id/edit",
        intent: "write-form",
      },
      holidayDelete: {
        pattern: "/admin/holidays/:id/delete",
        intent: "write-form",
      },
    },
  },
  // … 42 more areas
});
```

Rules of the shape:

- `audience` and `section` are per-area defaults. A destination can override
  them, because some areas mix audiences today (`dashboard` holds a staff home
  and a content-level listings landing).
- `segments` stays explicit only where an area serves routes with no UI
  destination (`markdownPreview`, `debug`). Everywhere else the segments derive
  from the destination patterns.
- Everything currently in `ADMIN_SURFACE` derives from this one table:
  destinations, area segments, nav model, `adminPath`, read-only patterns.
- `src/features/admin/area-loaders.ts` shrinks to the one fact that must live in
  the features layer: `Record<AdminAreaId, () => import(…)>`, with literal
  import specifiers so esbuild can bundle each target. The shared `AdminAreaId`
  key type makes an absent loader a compile error.
- Route tables consume the declaration instead of a repeated string:
  `crudRoutes` and `entityTabRoutes` take the declared destination, and
  `defineRoutes` keys derive from the declared patterns.
- Auth policies derive from the declared audience: `formPolicy(destination)`,
  `multipartPolicy(destination)`, `apiPolicy(destination, { allowApiKey })`
  build the `AuthPolicy` with `roles` from the declaration. The body kind and
  CSRF options stay facts of the handler. The named presets (`OWNER_FORM`,
  `CONTENT_FORM`, …) remain only for routes outside the admin surface.

Cold-start note: the declaration stays cheap module-load data, exactly like the
current tables. The eager path still imports no handler module, and no top-level
await appears.

## Challenge — questions asked and answered

- _What if an audience and a policy disagree today?_ The migration surfaces each
  case. Each one is triaged in review, fixed on the stricter side unless the
  human decides otherwise, and pinned with a regression test.
- _What if two areas share one segment?_ `groups` and `bulkActions` do. The
  segment router already merges the maps, and the derivation keeps that.
- _What if an area has routes but no destinations?_ `markdownPreview` and
  `debug` keep an explicit `segments` list. The manifest test keeps its proof
  that segments and routes agree.
- _What if a nav entry must hide behind a feature flag?_ Nav `visible` stays a
  navigation-only fact. The audience gates access. Both already exist and do not
  merge.
- _What about POST handlers with no destination of their own?_ They take their
  policy from the destination they belong to via `formPolicy(destination)`, so
  the tie is by construction. A handler that genuinely needs a different role
  set declares a destination-level override, which makes the difference visible
  in one place.
- _What breaks if a derivation is wrong?_ The manifest test, the nav tests, the
  new role-matrix test, and every admin integration test that exercises real
  dispatch.
- _Replay, retries, money, races?_ Not applicable. The change adds no write.

## Slices

Three slices, bottom up. Each is complete and green on its own. The database and
provider call budget is zero for all three: the change is module-load data, not
runtime IO.

1. **One declaration per area.** — **Built.**
2. **The path becomes one fact.** — **Built.** `adminPattern(id)` returns the
   path a route declares, keeping the literal type so the route keys built from
   it stay typed. The nine entity pages and five CRUD tables bind under it, and
   every `basePath`, `navActive`, and `listPath` reads `adminPath` or
   `adminPattern`.

   `entityTabRoutes` takes the record page's own path instead of a base plus a
   separate parameter name, so `/admin/attendees/:attendeeId` states the record
   parameter once. A path that names no record is refused when the table is
   built, which is module load, so it can never reach a request.

   The entity base did become a declared fact, and so did 37 other admin GET
   routes that named no audience at all: every record page, the guide, the log,
   the sign-in and sign-out pages, the seeds and SMS tools, and nine downloads.
   The surface went from 111 routes to 149.
3. **The role becomes one fact.** — **Built for the shared frameworks, checked
   everywhere else.**

   Derived: an entity page names the route it serves and takes both its URLs and
   its auth floor from it, so `basePath` and `guard` are gone from all eleven
   page definitions. The floor is every role that can reach any route beneath
   the page, because a tab open to a wider role sits under the same path.
   `createOwnerCrudHandlers`, `createCrudHandlers`, and
   `createContentCrudHandlers` are one factory in `crud-handlers.ts` whose six
   routes each take their gate from the route they guard. Groups kept three
   bundles only to mix a staff-only delete with editor-reachable edits, and now
   has two, which differ in which resource writes the row.

   Checked: `test/integration/admin-role-matrix.test.ts` asks all 149 routes.
   See [What remains](#what-remains) for the gates still written twice.

A later, separate candidate: the app layer keeps four parallel prefix-keyed
tables (`PREFIX_LOADERS`, `PREFIX_MESSAGE_GROUPS`, `PREFIX_GATES` in
`src/features/app/routes.ts`, `PREFIX_SETTINGS` in
`src/features/settings-bundles.ts`). The same fold applies one level up, and is
out of scope here.

## Tests that prove the contract

- **Forwards**, `test/integration/admin-route-manifest.test.ts`: every route
  falls under a segment its area declares, every declared segment serves a
  route, no two method and path pairs collide, every declared route has a GET
  route serving it, and — the check that keeps the map complete — every GET
  route has a destination saying who may reach it.
- **Backwards**, `test/integration/admin-role-matrix.test.ts`: 61 parameter-free
  pages, asked as all four roles, both ways round. The 88 record pages, asked as
  the roles they exclude; no record needs to exist, because the gate runs before
  the lookup. The 91 declared paths that also take a write, asked with their own
  method and a real CSRF token, so the role gate is the only thing left that can
  refuse them — first as the roles each route excludes, then as the roles it
  admits, so a gate that refuses everybody fails as loudly as one that admits
  everybody. The insider walk leaves `POST /admin/logout` out, because a
  successful logout ends the session the rest of the walk needs.
- The declaration's own rules are in `test/shared/admin-surface/`, and the
  navigation model in `test/shared/admin-pages.test.ts`.
- Every slice runs `deno task precommit`. The branch mutation gate,
  `deno task precommit:mutation`, runs once over the whole branch rather than
  per slice, because it scopes by changed file and these slices changed 40 of
  them. The first run found 246 survivors, 244 of them older gaps in the files
  the slices touched. All are closed: each file has its own commit, and the 27
  mutants that no input can distinguish are recorded in
  `scripts/mutation/equivalent-mutants/` with their proofs.

## Questions the reviewer answered

1. **Is overruling "the stricter side wins" for `deliveries` the outcome you
   want?** Yes. Delivery agents keep the run sheet, and the declaration says so.
2. **Does the entity detail base become a declared fact?** Yes, along with every
   other admin GET route that had no declaration.
3. **Is deriving the handler policies worth the churn?** Yes, and it was done
   where the duplication was systematic. See [What remains](#what-remains) for
   what was left, and why.

## What remains

Two measured gaps, recorded rather than left implicit.

1. **The gates in bespoke handlers are still written twice.** About 150 uses of
   `OWNER_FORM`, `AUTH_FORM`, `SITE_FORM`, `CONTENT_FORM`, `ownerPage`,
   `sessionPage`, `contentPage`, `sitePage`, and their `require*Or` guards
   remain across roughly 50 files, three to thirteen each. Each is one route
   with one gate, not a drifting pair the way the three CRUD factories were, and
   the role matrix now compares every one of them with its declaration.
   Migrating them is de-duplication, not a safety fix. Use `pageGuardFor` and
   `formPolicyFor`, which take the route a handler serves.
2. **Ninety-eight write routes sit at a path no route declares** — mostly the
   settings sub-forms, the reorder moves, and the image uploads. Their roles are
   in the handler alone, and nothing compares them with anything.
   `test/integration/admin-role-matrix.test.ts` states the number, so the gap
   cannot widen unnoticed. Closing it means declaring those routes, which is a
   slice of its own. The same slice can let every tab of a record page declare
   its own audience, in place of the `visible` predicate that hides it today.

## The shortlist — other rooms the survey found

Ranked runners-up, kept here so they are not lost. Each can become its own plan.
None of them blocks, or is blocked by, the admin surface work.

1. **One client for outbound HTTP.** Twelve modules re-implement base URL + auth
   header + status check + error parse + JSON parse (`bunny-cdn.ts` 670 lines,
   `bunny-db.ts`, `turso-api.ts`, `deno-deploy-api.ts`, `sms/gateway.ts`,
   `address-lookup/easypostcodes.ts`, `botpoison.ts`, `storage.ts`, `ntfy.ts`,
   and the three payment transports). There is measured type-level drift:
   `bunny-db.ts` returns `bunny-cdn.ts`'s foreign error shape through
   `Result<T>`-typed functions, and `bunny-cdn.ts:63,474` cast untrusted API
   bodies with a bare `as T`. A `defineApiClient` that returns `Result<T>` and
   validates bodies through a supplied valibot schema removes an estimated
   400–600 lines. Deferred here because it grazes the payment transports while
   PLAN.md M6–M11 is in flight.
2. **One admin page opener.** `src/ui/templates/admin/admin-page.tsx` holds 15
   opener variants (seven differ only in the flash argument shape), plus five
   bespoke shells and three page-set factories — 23 ways to open a page over one
   23-line `AdminPage`. Fourteen list pages hand-compose the same empty-check →
   table → guide footer → action row body. An `AdminPageSpec` schema plus one
   renderer removes an estimated 500 lines and, more important, the choice that
   regenerates the drift.
3. **`defineStatement` for hand-ordered SQL parameters.** The sweep answers the
   open question in `TODO.md` ("Numbered SQL parameters", from PR #2040): 33
   statements across 26 files bind at least one value more than once, in two
   dialects (repeated positional args, and `?N` kept honest by prose comments).
   The largest are money-adjacent: 16 bound values in
   `provider-refund-authority.ts:221`, 10 in `payment-anchor/attendee.ts:71`. A
   schema-first statement definition removes the silent argument-order bug
   class.
4. **A per-provider transport-error descriptor.** The three payment providers
   classify the same three transport error classes twice each (once for
   reads/refunds, once for checkout) — six hand-kept mappings, ~170 lines,
   already drifted in three measurable ways. Two cheap adjacent fixes need no
   design: Square's settings form re-implements `ProviderKeyBlock` inline
   (`ui/templates/admin/settings/payment.tsx:254-278`), and Square's checkout
   bypass of `makeCreateCheckoutSession` is recorded in `TODO.md` as a behaviour
   divergence.
