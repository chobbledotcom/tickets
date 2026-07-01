# Site upgrade: top-level "Site" + user-created Pages, page items, and a recursive public nav

## Summary

Two connected changes:

1. **Promote "Site" to a top-level admin section** (when the public site is
   enabled). Today "Site" is buried under **Settings → Site** for owners
   (`resolveSection`, `src/ui/templates/admin/nav.tsx:204-218`) and is only
   top-level for editors (`editorTopLevelItems`, `nav.tsx:94-98`). We unify
   these: **Site becomes a top-level link for everyone who can edit it**
   (owner + editor — `SITE_ADMIN_LEVELS`), gated on `settings.showPublicSite`,
   and drops out of the Settings sub-nav. This deletes the bespoke
   `nested`/`includeSite` third-level machinery that only exists to reach Site.

2. **Introduce user-created content Pages**, a tree of pages that can contain
   listings, groups, and other pages. Owners/editors add, edit, and **reorder**
   pages and their items under the Site menu. On the public site, root-level
   pages appear in the main nav **between "Listings" and "Contact"**; when the
   visitor is on a page that has a parent, we render **recursive contextual
   submenus** — the current node's siblings, its parent's siblings, its
   grandparent's siblings, … up to the root — exactly like the admin nav does
   today (nested on desktop, separate stacked bars on mobile), but generalised
   to arbitrary depth.

This document is the **plan**. Nothing is built yet. Where it names concrete
files/lines they are the current code the work builds on, verified against the
tree at the time of writing.

---

## Naming note (read first)

There is already a `src/features/public/pages.ts` — it is **not** an entity
module; it holds the public home/listings/terms/contact route handlers
(`handleHome`, `handlePublicListings`, `handlePublicContact`, …). To avoid a
collision and endless confusion, the new entity is called **`site_pages`** in
code, even though it is "Pages" in the UI:

- DB module: `src/shared/db/site-pages.ts` (table `site_pages`) and
  `src/shared/db/site-page-items.ts` (table `site_page_items`).
- Admin: `src/features/admin/site-pages.ts`, templates
  `src/ui/templates/admin/site-pages.tsx`.
- Public: `src/features/public/site-page.ts` (renders one page), plus the
  recursive nav in the public templates.

The UI text, menu label, and slugs still read "Pages". Only the code
identifiers carry the `site_` prefix.

> **Decision N1 — ✅ DECIDED: `site_pages` / `site_page_items`.** The tables and
> code identifiers carry the `site_` prefix (the existing `public/pages.ts` keeps
> its name); the UI still reads "Pages".

---

## Data model

### Table `site_pages`

One row per user-created page. **All free-text columns are encrypted** with
`DB_ENCRYPTION_KEY` via the existing `col.encrypted*` helpers
(`src/shared/db/table.ts`); the HMAC blind index and the integer order are
plaintext (they must be queryable/sortable).

| column             | type / storage                                   | notes |
| ------------------ | ------------------------------------------------ | ----- |
| `id`               | `INTEGER PRIMARY KEY AUTOINCREMENT`              | `col.generated` |
| `slug`             | `TEXT NOT NULL` — **encrypted**                  | `col.encrypted(encrypt, decrypt)` |
| `slug_index`       | `TEXT NOT NULL` — plaintext HMAC blind index     | from `idAndEncryptedSlugSchema` (decided, N2) |
| `name`             | `TEXT NOT NULL` — **encrypted**                  | menu label + `<h1>` |
| `meta_title`       | `TEXT NOT NULL DEFAULT ''` — **encrypted**, ≤ 64 | `<title>` override |
| `meta_description` | `TEXT NOT NULL DEFAULT ''` — **encrypted**, ≤ 160| `<meta name=description>` |
| `content`          | `TEXT NOT NULL DEFAULT ''` — **encrypted**, ≤ `MAX_TEXTAREA_LENGTH` (10 240) | markdown body |
| `order`            | `INTEGER NOT NULL DEFAULT 0`                      | position among **root-level** pages |

- **`order`** is a SQL reserved word. Store the column as **`sort_order`** to
  match the existing convention (`questions.sort_order`,
  `answers.sort_order` — `swapSortOrder`, `src/shared/db/questions.ts`) and
  avoid quoting. The request's "order (int)" maps to `sort_order`.
- Unique index `idx_site_pages_slug_index` on `(slug_index)` — the blind-index
  lookup path, identical to `idx_listings_slug_index` /
  `idx_groups_slug_index`.
- Field length caps (64 / 160 / `MAX_TEXTAREA_LENGTH`) are enforced in the form
  layer (`field.maxlength`, checked server-side in `validateSingleField`,
  `src/shared/forms.tsx:404-409`), not in SQL.

> **Decision N2 — ✅ DECIDED: `slug_index`.** The column is named **`slug_index`**
> and comes for free from the shared `idAndEncryptedSlugSchema(encrypt, decrypt)`
> helper (`src/shared/db/common-schema.ts:49-66`), with the HMAC computed by
> `hmacHash` (`src/shared/crypto/hashing.ts:136-150`) — exactly as listings and
> groups do it. This keeps `slug` + blind-index generation/lookup on the one
> shared mechanism the whole codebase already uses (no bespoke `slug_hmac`
> column, no duplicated schema).

### Table `site_page_items`

The membership/ordering edges. A page contains an **ordered list of items**,
each of which is a listing, a group, or another page.

| column      | type                                | notes |
| ----------- | ----------------------------------- | ----- |
| `page_id`   | `INTEGER NOT NULL`                  | the containing `site_pages.id` |
| `item_type` | `TEXT NOT NULL`                     | `'listing' \| 'group' \| 'page'` |
| `item_id`   | `INTEGER NOT NULL`                  | id in the referenced table |
| `sort_order`| `INTEGER NOT NULL DEFAULT 0`        | position within the page |

Indexes:

- `idx_site_page_items_page` on `(page_id, sort_order)` — the primary read
  (load a page's items in order).
- `idx_site_page_items_key` **unique** on `(page_id, item_type, item_id)` — the
  request's "keyed off … item_type, item_id"; stops the same item being added
  to one page twice.
- `idx_site_page_items_child_page` on `(item_type, item_id)` — a **plain**
  (non-unique) index backing the reverse "who is this item's parent?" lookup.

> **The single-parent invariant can't be a partial unique index.** An earlier
> draft proposed a partial-unique index `(item_id) WHERE item_type = 'page'`.
> The schema machinery **cannot express a `WHERE` predicate**: `Index` carries
> only `name`/`columns`/`unique`, and `createIndexSql`
> (`src/shared/db/migrations/schema-sync.ts:115-117`) emits only
> `CREATE [UNIQUE] INDEX … ON table(cols)` — anything created outside `SCHEMA`
> would be dropped by `syncIndexes`. A *non-partial* unique index on `item_id`
> is wrong too: it would reject a listing and a page that happen to share a
> numeric id, and block the multi-parent leaves N3 explicitly allows. So the
> **single-parent invariant for pages is enforced in application code** — the
> add-item handler rejects adding a `page` item whose id already appears as a
> `page` item anywhere (`SELECT 1 FROM site_page_items WHERE item_type='page'
> AND item_id = ?`), failing closed with a clear operator error — not by a DB
> constraint. (If a DB-level guarantee is later wanted, extend the schema
> `Index` type with an optional predicate and teach `createIndexSql` /
> `syncIndexes` about it; that's a schema-machinery change to scope separately.)

> The request wrote "keyed off **category_id**, item_type, item_id". There is no
> `category_id` on this table; this is read as a typo for **`page_id`** (the
> only foreign key present). If a real `category_id` concept was intended,
> that's a larger scope change — flag it. Plan assumes `page_id`.

> **Decision N3 — ✅ DECIDED: pages form a tree (single parent).** The recursive nav
> ("*our* siblings, *our parent's* siblings, …") only has a well-defined meaning
> if each page has exactly one parent. The **application-level check** above
> enforces it: adding page P under a second parent fails closed with a clear
> operator error. **Listings and groups are leaves and may appear under multiple
> pages** (only `item_type='page'` rows are constrained). See decision N6 for how
> the contextual nav tie-breaks a multi-parented leaf.

### Roots and ordering

- A page is **root-level** iff no `site_page_items` row references it
  (`item_type='page'`, `item_id = page.id`). Root pages are ordered by
  `site_pages.sort_order`; nested items are ordered by
  `site_page_items.sort_order`. (Minor redundancy: a page always carries a
  `sort_order` even while nested, where it's unused. Accepted — it means a page
  promoted to root already has a stable position, and it mirrors the
  questions/answers split.)

### Types

Add to `src/shared/types.ts`, modelled as an **exhaustive union + `Record`** per
the "shared interfaces over branch-per-case" and "schema over organic structure"
guidance in AGENTS.md:

```ts
export type SitePageItemType = "listing" | "group" | "page";

export interface SitePage {
  id: number;
  slug: string;
  slug_index: string;
  name: string;
  meta_title: string;
  meta_description: string;
  content: string;
  sort_order: number;
}

export interface SitePageItem {
  page_id: number;
  item_type: SitePageItemType;
  item_id: number;
  sort_order: number;
}
```

Resolution of an item to a nav link is a fold over an **exhaustive
`Record<SitePageItemType, …>`** (a missing arm becomes a compile error), so
adding a fourth item type later is additive:

This `Record` is the seed of the whole design; the next section makes it the
spine.

---

## Functional core: a pure, schema-driven pipeline

The whole feature is deliberately shaped as **three rings**, so that all the
logic worth testing lives in the middle ring as pure, total functions over plain
data — no DB, no crypto, no `Request`, no JSX:

```
┌── impure shell: acquire ──────────────────────────────────────────────┐
│   DB reads (cached), decryption, discovery/liveness classification,    │
│   session/params  →  produce PLAIN DATA (arrays, maps, primitives)     │
│                                                                        │
│   ┌── pure core (src/shared/site-pages/core.ts) ──────────────────┐   │
│   │  forest build · ancestry · cycle check · nav-model build ·    │   │
│   │  reorder planning · next-order · input validation.            │   │
│   │  Total functions: plain data in → plain data out. No I/O.     │   │
│   └───────────────────────────────────────────────────────────────┘   │
│                                                                        │
│   impure shell: apply  →  DB writes / batches, redirects, HTML render  │
└────────────────────────────────────────────────────────────────────────┘
```

**Everything flows through the core.** A handler's job shrinks to: authorise →
load plain data → **call one core function** → apply the result (write or
render). The DB modules produce plain rows; the templates consume a plain view
model; the interesting decisions all happen in `core.ts`, which imports nothing
but types.

### The data the core speaks

Beyond the raw `SitePage` / `SitePageItem` rows, the core uses three plain
shapes (all in `src/shared/site-pages/types.ts`, no imports):

```ts
// A stable string key for any item — the composite (type,id) the whole
// system is keyed on. One function mints it; everything compares by it.
export type TargetKey = `${SitePageItemType}:${number}`;
export const targetKey = (t: SitePageItemType, id: number): TargetKey => `${t}:${id}`;

// A leaf's resolved presentation + reachability, produced by the acquire ring
// (this is where discovery/liveness classification for listings/groups lands).
export interface ResolvedTarget { href: string; label: string; live: boolean; }
export type TargetMap = ReadonlyMap<TargetKey, ResolvedTarget>;

// The adjacency view the core builds once and reuses. Pure, serialisable.
export interface Forest {
  byId: ReadonlyMap<number, SitePage>;        // page id → row
  itemsByPage: ReadonlyMap<number, readonly SitePageItem[]>; // page id → items, sorted
  parentByChild: ReadonlyMap<number, number>; // child page id → parent page id
  rootIds: readonly number[];                  // pages with no page-parent, sorted
}

// The view model the templates render — a recursive tree, nothing DB-shaped.
export interface NavNode {
  key: TargetKey;
  href: string;
  label: string;
  live: boolean;                 // false ⇒ render as text, never a link
  active: boolean;               // on the current node's ancestor chain
  children: readonly NavNode[];
}
export interface NavModel {
  rootPageNodes: readonly NavNode[];   // splice between Listings and Contact
  submenuLevels: readonly (readonly NavNode[])[]; // stacked ancestor sibling-sets, root-first
  activeRootId: number | null;         // which root page to highlight
}
```

### The core functions (pure, total, unit-tested in isolation)

`src/shared/site-pages/core.ts` — every function here is deterministic and
side-effect-free; each gets a direct table-driven / property test.

```ts
// 1. Build the adjacency model. Sorts inputs by (sort_order, id) ITSELF, so the
//    core is independent of DB row order (tests feed unordered fixtures). Uses a
//    visited guard so a corrupt cyclic row set terminates and throws loudly
//    rather than looping — the app guarantees acyclic (N3/N4), so a cycle here
//    is an impossible state to surface, not to absorb (AGENTS: trust invariants).
buildForest(pages: readonly SitePage[], items: readonly SitePageItem[]): Forest

// 2. Ancestry (root-first, excludes the node itself) and descendants.
ancestorsOf(forest: Forest, pageId: number): number[]
descendantsOf(forest: Forest, pageId: number): Set<number>

// 3. Cycle guard for the item picker + POST re-check (N4). Placing `candidate`
//    under `parent` loops iff candidate === parent OR candidate ∈ ancestors(parent).
wouldCreateCycle(forest: Forest, parentPageId: number, candidatePageId: number): boolean
eligibleChildPages(forest: Forest, currentPageId: number): SitePage[] // picker options

// 4. THE nav computation — the heart. Pure: forest + resolved leaves + "where am
//    I" → the full view model (root nodes, active chain, stacked submenu levels).
buildNavModel(forest: Forest, targets: TargetMap, current: TargetKey | null): NavModel

// 5. Reorder planning — ONE function both root-page and within-page reorder flow
//    through. Given the ordered keys and a move, returns the adjacent pair to
//    swap, or null at a boundary. The impure shell just executes the swap.
planReorder(orderedKeys: readonly TargetKey[], target: TargetKey, dir: "up" | "down"):
  readonly [TargetKey, TargetKey] | null
nextSortOrder(existing: readonly number[]): number   // max+1, or 0 when empty

// 6. Input validation (schema-driven, reused by create + update).
validateSitePageInput(input: SitePageInput): string | null
isReservedSlug(slug: string): boolean                 // shadows home/listings/contact/…
```

### Node building is one exhaustive `Record` (the schema spine)

The `ITEM_RESOLVERS` sketch above becomes a total `Record` inside the core that
turns each item into a `NavNode`. It is the *only* place the item-type union is
branched on — a new type is a compile error until every arm is filled:

```ts
type NodeBuilder = (ctx: BuildCtx, item: SitePageItem) => NavNode;

const NODE_BUILDERS: Record<SitePageItemType, NodeBuilder> = {
  // leaves: presentation + liveness come from the pre-resolved TargetMap
  listing: buildLeaf,
  group:   buildLeaf,
  // page: label from the forest row, href /page/:slug, always live, RECURSE
  page:    buildPageNode,
};
```

`buildLeaf` reads the `TargetMap` (so *all* the listing/group liveness rules —
`classifyForDiscovery`, child-listing suppression, `groupHasBookableMember` — are
computed once in the acquire ring and handed in as data); `buildPageNode` recurses
through `forest.itemsByPage`. Both are pure. `buildNavModel` folds
`NODE_BUILDERS[item.item_type]` over the forest and marks `active` on the
`ancestorsOf(current) ∪ {current}` set.

### How each ring plugs in

- **Acquire (`src/shared/db/site-pages.ts` + `site-page-items.ts` + a small
  `resolve-targets.ts`).** Load pages + items (cached), and build the `TargetMap`
  from listings/groups via an **exhaustive `Record<SitePageItemType, loader>`**
  (`page` targets resolve from the pages themselves). This is the only ring that
  touches the DB, crypto, and discovery classification.
- **Core.** Everything in the list above. Zero imports beyond types.
- **Apply — admin handlers.** `planReorder` → `swapSitePageOrder` /
  `swapItemOrder`; `validateSitePageInput` before insert/update;
  `eligibleChildPages` to render the picker and `wouldCreateCycle` to re-check the
  POST; `nextSortOrder` for create. The handler is a 4-line shell.
- **Apply — public nav/render.** `buildForest` + `buildNavModel` → the recursive
  desktop/mobile renderers (which are themselves pure `NavNode[] → JSX`, see the
  public-nav section). The route handler just supplies `current`.

### Why this shape

- **Testing is cheap and strong.** The core is plain-data-in/plain-data-out, so
  it gets exhaustive table-driven and property tests without a DB or a rendered
  page: e.g. *rootPageNodes = roots sorted by sort_order*; *active chain = exactly
  `ancestorsOf(current) ∪ {current}`*; *every leaf `node.live` equals its
  `TargetMap` entry*; *`planReorder` at either boundary is `null` and is its own
  inverse*; *`wouldCreateCycle` is true for every ancestor and false otherwise*;
  *`buildForest` is order-independent*. These are exactly the assertions that kill
  mutants (`test:quality-audit` / `deno task mutation`), so the 100 % coverage the
  repo requires is *meaningful* coverage, not incidental.
- **The shells barely need testing.** One integration test per route confirms the
  wiring; all the logic is already proven in the core.
- **It matches the house style.** Exhaustive `Record`s keyed by a union, a typed
  tree instead of hand-nested markup, and pure folds over data are precisely the
  "schema over organic structure" / "shared interfaces over branch-per-case"
  patterns AGENTS.md calls for — and `planReorder` unifies the two reorder paths
  into one (the "unify systems" rule).

---

## DB layer

Follow the groups module (`src/shared/db/groups.ts`) — it's the closest analog
(few rows, encrypted name + encrypted slug + HMAC index, whole-set cache).

### Migration

New file `src/shared/db/migrations/2026-07-01_site_pages.ts` (date-prefixed like
every migration; today is 2026-07-01):

```ts
export default schemaMigration(
  "2026-07-01_site_pages",
  "Add site_pages and site_page_items tables backing user-created content pages",
  {
    newTables: ["site_pages", "site_page_items"],
    indexes: [
      "idx_site_pages_slug_index",
      "idx_site_page_items_page",
      "idx_site_page_items_key",
      "idx_site_page_items_child_page",
    ],
  },
);
```

- Register it: import + append to `MIGRATIONS` in
  `src/shared/db/migrations.ts:207+` (append-only, ordered by date).
- Add both table definitions to `SCHEMA` in
  `src/shared/db/migrations/schema.ts` (ordered by FK dependency —
  `site_pages` before `site_page_items`) and bump `LATEST_UPDATE`.
- The migration/schema guard tests (`test/lib/db/migration-schema-guard.test.ts`,
  `migrations.test.ts`) assert the live schema matches `SCHEMA` — they'll cover
  the DDL for free once both sides agree.

### `src/shared/db/site-pages.ts`

```ts
const rawSitePagesTable = defineIdTable<SitePage, SitePageInput>("site_pages", {
  ...encryptedNameSchema(encrypt, decrypt),      // name
  ...idAndEncryptedSlugSchema(encrypt, decrypt), // id, slug (enc), slug_index (hmac)
  meta_title: col.encryptedText(encrypt, decrypt),
  meta_description: col.encryptedText(encrypt, decrypt),
  content: col.encryptedText(encrypt, decrypt),
  sort_order: col.simple<number>(),
});
```

Wrap in a `cachedEntityTable` exactly like groups (whole-set cache keyed by
`slug_index`, ~30 s TTL): `fetchAll: () => query("SELECT * FROM site_pages
ORDER BY sort_order ASC, id ASC")`, `keyOf: (p) => p.slug_index`. Export:

- `getAllSitePages()` — cache `getAll` (ordered), for the admin list + nav.
- `getSitePageBySlugIndex(slugIndex)` — cache `getByKey`, for the public route.
- `computeSitePageSlugIndex(slug) = hmacHash(slug)`.
- `sitePagesTable` + `invalidateSitePagesCache()`.
- `swapSitePageOrder(id1, id2) = swapSortOrder("site_pages", id1, id2)` and
  `assignNextSitePageSortOrder(id)` — the questions pattern verbatim
  (`src/shared/db/questions.ts` / `swapSortOrder` in `query.ts`).

### `src/shared/db/site-page-items.ts`

Model on `listing-parents.ts` (an ordered link table with batch replace):

- `getItemsForPage(pageId): Promise<SitePageItem[]>` — `SELECT item_type,
  item_id, sort_order FROM site_page_items WHERE page_id = ? ORDER BY
  sort_order` (only the columns needed).
- `getItemsForPages(pageIds)` — batched `WHERE page_id IN (…)` grouped into a
  `Map<number, SitePageItem[]>`, for building the whole nav tree in one query
  (the `groupEdges` shape from `listing-parents.ts`).
- `getParentPages(itemType, itemId): Promise<{ pageId: number; sortOrder:
  number }[]>` — reverse lookup for the contextual nav, returning **all**
  candidate parents **ordered by `(sort_order, page_id)`**. A bare `WHERE
  item_type=? AND item_id=?` returning a single row can't distinguish
  zero/one/many parents and is nondeterministic. For `item_type='page'` this is
  0-or-1 (N3); for leaves it may be many, and the caller applies the N6
  tie-break to the ordered list (the ordering lives in this API so every caller
  is deterministic).
- `addItem` / `removeItem` / `swapItemOrder(pageId, keyA, keyB)` /
  `assignNextItemSortOrder(pageId)` — items are reordered **within their page**.
  Because a page's items are keyed by the **composite** `(item_type, item_id)`
  (`item_id` alone is *not* unique within a page — a listing, a group, and a
  page can share a numeric id, and the `:itemKey` route encodes both), the swap
  takes **two full item keys**, matching on `(page_id, item_type, item_id)` for
  each side — never `item_id` alone, which could update the wrong or multiple
  rows. (Adapt `swapAnswerOrder`, which swaps two explicit `(id, sort_order)`
  pairs, widening the match to the composite key.)
- On page **delete**: delete the `site_pages` row **and** its own
  `site_page_items` rows **and** any rows pointing *at* it (`WHERE (page_id = ?)
  OR (item_type='page' AND item_id = ?)`) **in one `executeBatch`/transaction**,
  so a failure can't leave the row gone but edges dangling (or vice versa). This
  means the page delete must **not** go through the CRUD factory's separate
  delete (which would delete only the `site_pages` row): hand-wire the delete to
  batch the row + all edge cleanups atomically. Its former children become
  root-level (they simply stop being referenced). On listing / group delete:
  also clear `site_page_items WHERE item_type=? AND item_id=?` in the same batch
  as the existing listing/group delete (— "never render a dead link", and don't
  leave orphan edges).

All writes call `invalidateSitePagesCache()` (and reuse the cache-dependency
registration in `cachedEntityTable` so listing/group edits that could change a
link's liveness don't serve stale nav — register `site_page_items` as depending
on `listings`/`groups` if needed).

---

## Admin: Site as a top-level section + Pages CRUD

### 1. Nav change (`src/ui/templates/admin/nav.tsx`)

- **Add "Site" to `topLevelItems`**, positioned near the end (before Settings).
  The non-editor branch of `topLevelItems` serves **owner, manager, and agent**
  (owner-only entries there are already `session.adminLevel === "owner"`
  guarded). `/admin/site` is gated to `SITE_ADMIN_LEVELS` (owner + editor), so
  the link must carry **both** guards or managers/agents would see a forbidden
  link: `session.adminLevel === "owner" && settings.showPublicSite ? { href:
  "/admin/site", label: t("nav.site") } : null`. Editors already have it
  top-level (`editorTopLevelItems`) — unchanged. (Managers/agents never get a
  Site link, matching the 403 the route enforces.)
- **Remove Site from `settingsSub`** (delete the `includeSite || showPublicSite`
  entry, `nav.tsx:152-154`).
- **Simplify `resolveSection`**: the Site section now resolves the same way for
  owner and editor — `topHref: "/admin/site"`, `items: siteSub()`. Delete the
  `active === "/admin/site"` owner branch that injected the third-level `nested`
  Site sub-nav under Settings (`nav.tsx:211-218`), and delete the `NestedSub`
  plumbing if nothing else uses it (it exists *only* for Site today — a genuine
  simplification, per "unify systems").
- **Extend `siteSub()`** with the Pages entry:
  `{ href: "/admin/site/pages", label: t("nav.site.pages") }` — so Site's
  sub-nav is Homepage / Contact / Order / Pages.

The individual page editor and its item management live under
`/admin/site/pages/*`; those pages set `active="/admin/site"` so the Site
top-level link highlights and the Site sub-nav shows — no new nav depth needed
(this is why Pages management is a flat CRUD under Site rather than another nav
level).

### 2. Pages CRUD (`src/features/admin/site-pages.ts`)

Reuse the CRUD factory (`createContentCrudHandlers` /`defineNamedResource`,
`src/features/admin/owner-crud.ts:66-90`) — but gated to **`SITE_FORM` /
`requireSiteOr`** (owner + editor, `src/features/auth.ts:275-280`) rather than
owner-only, matching the rest of the Site editor. If the factory's auth isn't
parameterisable to `SITE_ADMIN_LEVELS`, follow the holidays hand-wiring
(`src/features/admin/holidays.ts`) with `SITE_FORM`.

Two factory mismatches to handle explicitly:

- **Create must assign a root `sort_order`.** The factory's create path just
  inserts the parsed form input and redirects — it has no after-create hook, and
  `sort_order` is not a form field, so a factory-created page would sit at the
  SQL default (0), giving every new root page the same order and no predictable
  move behaviour. Either **hand-wire create** (insert, then
  `assignNextSitePageSortOrder(id)` before redirect) or add a resource
  side-effect that runs after insert. The plan assumes hand-wired create.
- **Edit POST route.** The factory registers edit submissions at
  **`POST {listPath}/:id/edit`** (`owner-crud.ts:180`), *not* `POST
  {listPath}/:id`. The route table below and the form `action` use `/:id/edit`
  to match; if you hand-wire instead, keep handler and form action consistent.

Fields (`defineForm`, `src/shared/forms.tsx`):

- `name` — text, required.
- `slug` — the shared slug field (`getSlugField`,
  `src/ui/templates/fields.ts:741-750`: `normalizeSlug` + `validateSlug`),
  auto-generated for new pages via `generateUniqueSlug(computeSitePageSlugIndex,
  isSitePageSlugTaken)` (groups pattern, `src/features/admin/groups.ts:63-74`).
  **Uniqueness must be cross-checked against reserved public prefixes** — see
  "Public route & reserved slugs" below.
- `meta_title` — text, `maxlength: 64`.
- `meta_description` — text (or short textarea), `maxlength: 160`.
- `content` — textarea, `markdown: true`, `maxlength: MAX_TEXTAREA_LENGTH`,
  with the `FORMATTING_HINT` (auto preview link — same as homepage_text in
  `site.ts`).

Routes (`defineRoutes`, merged in `src/features/admin/index.ts` alongside
`siteRoutes`):

```
GET  /admin/site/pages                     list (with add button + reorder)
GET  /admin/site/pages/new                 add form
POST /admin/site/pages                     create
GET  /admin/site/pages/:id/edit            edit form + item manager
POST /admin/site/pages/:id/edit            update (matches factory route)
POST /admin/site/pages/:id/delete          delete (hand-wired atomic: row + edges)
POST /admin/site/pages/:id/move-up         reorder among roots (root pages only)
POST /admin/site/pages/:id/move-down
POST /admin/site/pages/:id/items           add an item (type + id)
POST /admin/site/pages/:id/items/:itemKey/remove
POST /admin/site/pages/:id/items/:itemKey/move-up    reorder within page
POST /admin/site/pages/:id/items/:itemKey/move-down
```

`:itemKey` encodes `item_type:item_id` (composite key). Reorder handlers mirror
`moveQuestionHandler`/`moveAnswerHandler` (`src/features/admin/questions.ts:514-555`):
load the ordered set, find the neighbour by index, `swap…Order`, redirect with a
flash message.

### 3. Templates (`src/ui/templates/admin/site-pages.tsx`)

- **List page**: table of pages, plus Edit / Delete. Add button →
  `/admin/site/pages/new`. Render `<AdminNav active="/admin/site" …>`.
  **Reorder controls apply only to root pages.** Root page order comes from
  `site_pages.sort_order`; a nested page's placement comes from its containing
  `site_page_items.sort_order`. Showing the root `ReorderControls`
  (`src/ui/templates/admin/questions.tsx:43-70`) on a nested page's row would
  move a field that is *ignored while it's nested* — the arrows appear to work
  but don't change the public nav. So render up/down arrows **only on root-page
  rows** (nested pages reorder through their parent's item manager). Either
  split the list into a "root pages" section (with arrows) and a flat "all
  pages" section (no arrows, just edit/delete), or annotate nested rows with
  their parent instead of arrows. Recommendation: a root-pages section with
  arrows + the rest listed for editing.
- **Edit page**: the `defineForm` fields for the page, **plus an item manager**
  — the ordered list of the page's items (each: type badge, resolved name,
  up/down reorder, remove), and an "Add item" control: a type `select`
  (Listing / Group / Page) + a dependent id `select`. Simplest first cut:
  three separate add-forms (one per type), each a `select` of eligible targets
  (all active listings; all groups; all *other* pages that aren't already this
  page's ancestor — to prevent cycles, see N4). Reuse `getSlugField` etc. from
  the fields module.

> **Decision N4 — cycle prevention.** Adding page X as a child of the current
> page P creates a cycle iff a path X → … → P already exists — i.e. **X is an
> ancestor of P** (or X is P itself). So the picker and the server-side guard
> must **reject P and all of P's ancestors** (equivalently: reject any candidate
> whose descendants already include P). Note the direction: an earlier draft
> said "exclude P's *descendants*", which is backwards — a descendant of P
> already has a parent, so the single-parent check (N3) blocks re-parenting it,
> but a root ancestor A of P has *no* parent, so N3 does **not** stop adding A
> under P and closing an A → … → P → A loop. Compute P's ancestor chain by
> walking parents up to the root, exclude it (plus P) from the `select` options,
> and **re-check server-side on POST**, failing closed. The recursive nav must
> never be able to loop.

### Permissions

Everything under `/admin/site/**` uses `SITE_FORM` (POST) / `requireSiteOr`
(GET) — owner + editor, managers excluded (`SITE_ADMIN_LEVELS`,
`src/shared/types.ts`). This matches the existing Site editor exactly and keeps
the nav honest (editors already see Site top-level; owners now do too when
`showPublicSite`). Never render the Site link when `!showPublicSite` for owners
(the public pages 404/redirect anyway — `requirePublicSite`,
`src/features/public/pages.ts`).

---

## Public: the page route and reserved slugs

### Route

Add a new single-segment prefix **`page`** to the dispatch table
(`prefixHandlers`, `src/features/index.ts:640`) handling `GET /page/:slug`:

- Resolve `getSitePageBySlugIndex(await computeSitePageSlugIndex(slug))`;
  404 (`notFoundResponse`) if absent.
- Gate on `settings.showPublicSite` (reuse `requirePublicSite`); when the site
  is off, redirect to `/admin/login` like the other public pages.
- Render via the public layout: `<title>` = `meta_title || name || websiteTitle`
  (extend `Layout`'s `headExtra`, `src/ui/templates/layout.tsx:68`, to inject
  `<meta name="description" content=…>` when `meta_description` is set — the
  app has **no SEO meta today**, so this is net-new and should be a small,
  escaped helper), `<h1>` = `name`, body = `renderMarkdown(content)`
  (`src/shared/markdown.ts:47-49`), followed by the page's items rendered as a
  list of links/cards (reusing the listing/group card components where it
  makes sense).

> **Decision N5 — URL shape.** `/page/:slug` is chosen over a bare `/:slug`
> because dispatch is prefix-based (`getPrefix`, `index.ts:245`): a bare slug
> would need a catch-all fallback after every known prefix and would collide
> with future top-level routes. `/page/:slug` is unambiguous and cheap. (`/p/`
> is a shorter alternative if preferred.)

### Reserved slugs

Because `/page/:slug` is namespaced we don't collide with core routes, but the
**nav still surfaces pages as top-level items**, so keep slugs clean:
`validateSlug` already restricts to `[a-z0-9_-]+`. Add a reserved-word check in
`isSitePageSlugTaken` rejecting slugs equal to a known prefix
(`home`, `listings`, `order`, `terms`, `contact`, `admin`, …) purely to avoid
label confusion — cheap and prevents an operator naming a page "Contact" that
shadows the real one in the nav.

---

## Public: the recursive nav (the heart of the feature)

Today the public nav (`PublicNav`, `src/ui/templates/public/shared.tsx:17-54`)
is **flat**. The admin nav (`src/ui/templates/admin/nav.tsx`) already implements
the exact "nested on desktop, separate stacked bars on mobile" behaviour the
request wants — but hand-coded to a fixed 2–3 levels (`Section` + `NestedSub`).
The public feature needs the **same behaviour, recursively, to arbitrary depth**.

### Recommended: extract one shared recursive nav renderer

Per "unify systems — the answer is yes", model the nav as **data** (a recursive
tree) and render it with **one** component that emits both a nested-`<ul>`
desktop tree and a set of stacked mobile bars. The tree is the `NavModel` /
`NavNode` produced by the pure core (see "Functional core" above) — the
renderers are themselves pure `NavNode[] → JSX`, so they too are unit-tested by
feeding plain node fixtures and asserting the emitted structure:

- **`RecursiveDesktopNav(nodes)`** — nested `<ul>`/`<li>`, each node with
  `children` emits a nested `<ul class="admin-subnav">` (reuse the proven CSS
  classes `admin-nav--desktop` / `admin-subnav`, `style.scss:364-454`), the
  active chain gets the `active` class. This is `DesktopNav`
  (`nav.tsx:236-272`) made recursive instead of 2-deep.
- **`RecursiveMobileNav(levels)`** — one `mobileBar` per level along the active
  chain (`nav.tsx:276-299`), top-level first, each ancestor's sibling set as its
  own `<nav aria-label=…>` bar below.

The admin nav can later be re-expressed on top of this renderer (its 3 levels
are just a depth-3 tree); scope the *required* work to the public nav and note
the admin migration as a follow-up so this change stays bounded.

### Building the tree for a given request

This is just the acquire-ring + `buildForest`/`buildNavModel` flow from the
"Functional core" section, made concrete for a request:

1. **Load once (acquire).** `getAllSitePages()` + `getItemsForPages(allPageIds)`
   (two cached reads) plus the resolved `TargetMap` for the leaves. `buildForest`
   turns the rows into the `Forest` (roots ordered by `sort_order`, `itemsByPage`,
   `parentByChild`).

2. **Root nav** (`PublicNav`): Home, Listings, **then each root page** (ordered),
   then Order?/Terms?/Contact (the existing `navFlags`,
   `shared.tsx:60-64`). Root pages slot **after Listings, before the
   Order/Terms/Contact group** — matching "between listings and contact".

3. **Active chain / submenus.** Determine the **current node**:
   - On `/page/:slug` → that page.
   - On `/ticket/:slug` (a listing or group) → the leaf item, if it belongs to a
     page (reverse lookup). See N6.
   From the current node, walk **up to the root** collecting each ancestor. For
   each ancestor level, the submenu is that ancestor's **children** (i.e. the
   descendant's *siblings* incl. itself). This yields "our siblings, our
   parent's siblings, …, up to root" — the root-level ancestor is the root nav
   item that gets highlighted. Optionally include the **current node's own
   children** as the deepest submenu so visitors can navigate downward (natural;
   flagged as N7).

4. **Liveness (never render a dead link).** A `listing`/`group` item resolves to
   a link **only if the target is publicly reachable**. `active && !hidden` is
   **not sufficient** for a listing: a *child* listing (see `parents.md`) is
   suppressed from discovery and its `/ticket/:slug` is rejected by the ticket
   route (`anyChildListing`), so an active, visible child would emit a **dead
   `/ticket` link**. The liveness predicate must **mirror the existing discovery
   classification** — reuse `classifyForDiscovery` / `applyParentSoldOut` /
   `groupHasBookableMember` (`src/features/public/discovery.ts`, as
   `loadPublicGroups` does in `src/features/public/pages.ts`), not just the
   active/hidden flags. A non-live item renders as **plain text** (or is
   omitted), never a link that 404s — per AGENTS.md "never render a dead or
   forbidden link". `page` items are always live.

> **Decision N6 — multi-parented leaves.** A listing/group may sit under several
> pages (N3 only constrains pages). When the visitor is on `/ticket/:slug` for
> such a leaf, which ancestry do we highlight? Recommendation: if the leaf has
> **exactly one** parent page, show that chain; if it has **none**, show no
> contextual submenu (just the flat root nav); if it has **more than one**, pick
> the parent with the lowest `(sort_order, page_id)` deterministically (and
> document it). Simpler alternative: only render the contextual chain on
> `/page/:slug` views and never on listing/group views. Pick one; the plan
> assumes the deterministic-single-parent rule.

> **Decision N7 — show current node's own children?** Including the current
> page's children as the deepest submenu is the natural "you can go deeper"
> behaviour and costs nothing (already loaded). Recommended: **yes**. If the
> literal reading ("*our* siblings … up to root", i.e. stop at the current
> node's own level) is preferred, drop the deepest level.

### Wiring

`PublicNav` gains the site-pages tree. It's rendered by the public page
templates that already call it (`homepage.tsx`, `basic-pages.tsx`,
`order-gallery.tsx`, and the new `site-page` template). The nav data (forest +
current node) is built server-side per request from the two cached reads;
because it's needed on *every* public page, fold the required settings/reads
into the public layout path (`PUBLIC_LAYOUT_SETTINGS`,
`src/features/index.ts` — the settings-bundle work in `settings-plan.md`), and
add the site-pages reads there.

---

## i18n

Add keys under `src/locales/en/` (the app is fully translated — see
`I18N_REPLACEMENTS` in AGENTS.md): `nav.site.pages`, the Pages list/add/edit
headings and field labels/hints (`site.pages.*`, `fields.site_page.*`), item
manager strings, and confirm-delete copy. Follow the existing `site.*` /
`fields.*` naming.

---

## Testing & quality gates

Per AGENTS.md: **100% line+branch coverage**, **0% duplication**, mutation
survivors on changed files must be 0, and `deno task precommit` is the final
gate. Concretely (the pure core carries the bulk of the assertions — see
"Functional core"):

- **Functional core (`core.ts`)**: the heaviest test target, and the cheapest —
  plain-data-in/plain-data-out, no DB or render. Table-driven + property tests
  for `buildForest` (order-independence; roots = pages with no page-parent),
  `ancestorsOf`/`descendantsOf`, `wouldCreateCycle` (true for every ancestor and
  self, false otherwise), `buildNavModel` (root nodes = roots by `sort_order`;
  `active` set = `ancestorsOf(current) ∪ {current}`; each leaf's `live` mirrors
  its `TargetMap` entry), `planReorder` (null at both boundaries; self-inverse),
  and `nextSortOrder`. These are the mutation-resistant assertions that make the
  100 % coverage meaningful.
- **DB**: unit tests for `site-pages.ts` / `site-page-items.ts` — insert round-
  trips **through encryption** (assert the stored `slug`/`name`/`content` are
  ciphertext in the raw row and decrypt back), slug-index lookup, ordering,
  swap-order, the app-level single-parent check (adding a page under a second
  parent fails closed), atomic cascade cleanup on delete (no dangling edges),
  and cycle rejection.
- **Migration**: covered by the schema-guard/round-trip suites once `SCHEMA` and
  the migration agree; add a `migration-restore`-style assertion if needed.
- **Admin**: per-route tests for list/new/create/edit/update/delete/reorder and
  item add/remove/reorder, each rendered **as owner *and* as editor** (and
  asserting a manager is 403 — role downgrade removes access), plus a
  `!showPublicSite` case (Site link absent for owner, pages route redirects).
- **Public nav**: table-driven tests over a small forest asserting the rendered
  root order (root pages between Listings and Contact), the desktop nested `<ul>`
  structure, the mobile stacked bars, the active-chain highlight for a deep
  page, **dead-link suppression** (an inactive listing item renders as text not
  a link — the security-flavoured invariant), and the multi-parent tie-break.
- **Public page**: renders content markdown, `<title>`/meta from
  `meta_title`/`meta_description`, 404 for unknown slug, redirect when site off.
- Run `deno task test:quality-audit` + targeted `deno task mutation` on the new
  modules (especially the ordering swaps and the liveness predicate — classic
  mutation-survivor spots).

---

## Implementation sequence (each step green)

Hardest/foundational first (AGENTS.md "hardest first"):

1. **Schema + migration + DB modules** (`site-pages.ts`, `site-page-items.ts`)
   with full unit tests, encryption, ordering, single-parent + cascade +
   cycle-guard. No UI yet.
2. **Admin Site → top-level nav change** + Pages CRUD (list/add/edit/delete/
   reorder) — no item manager yet. Site reachable top-level; pages editable.
3. **Item manager** on the page edit screen (add/remove/reorder listing/group/
   page items; cycle-safe picker).
4. **Public `/page/:slug` route** + rendering (content, meta, item list).
5. **Recursive public nav** (shared renderer; root pages in main nav; contextual
   ancestor-chain submenus; desktop nested / mobile bars; dead-link suppression).
6. **(Follow-up, optional)** migrate the admin nav onto the shared recursive
   renderer to delete the last of the fixed-depth `Section`/`NestedSub` code.

Commit WIP checkpoints as you go (AGENTS.md "never lose work"); keep each commit
passing `deno task precommit`.

---

## Decisions (consolidated)

**Settled:**

- **N1 ✅** Code naming: `site_pages` / `site_page_items` (UI reads "Pages"; the
  existing `public/pages.ts` keeps its name).
- **N2 ✅** Blind-index column is `slug_index` via `idAndEncryptedSlugSchema`.
- **N3 ✅** Single-parent tree for pages, enforced by an application-level check
  (the schema can't express a partial-unique index).
- **Admin list ✅** Root-pages section with reorder arrows, the rest listed for
  editing without arrows.
- **`category_id` ✅** Read as a typo for **`page_id`** (the only FK on
  `site_page_items`).

**Still open (recommendation in parentheses; not blocking — sensible defaults
chosen):**

- **N4** Cycle prevention rejects the current page + its ancestors (required;
  design fixed, just flagging the invariant).
- **N5** Public URL: **`/page/:slug`** (recommended) vs `/p/:slug`.
- **N6** Multi-parented leaf ancestry tie-break: lowest `(sort_order, page_id)`
  (recommended) vs contextual nav only on `/page/:slug` views.
- **N7** Deepest submenu shows the current node's own children (recommended: yes).
