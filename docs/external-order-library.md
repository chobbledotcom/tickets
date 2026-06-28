# External Order Library

## Purpose

Give site owners a small JavaScript module they can add to an external website
so ordinary links on that site become "add to cart" controls for tickets hosted
by this app.

The library is a progressive enhancement over real public listing links. If the
module fails to load, JavaScript is disabled, or the external site is not
allowed by the owner's settings, each link still opens its listing's normal
ticket page.

The module is **self-contained**: it ships with a snapshot of the site's public
listings embedded at serve time, so the cart works entirely client-side. There
is no order/quote API and the widget makes no network requests of its own beyond
loading the module itself.

## Goals

- A site owner can add one module script tag to their external site template, or
  add the same tag multiple times without duplicate UI or duplicate handlers.
- A site owner can mark an external link with `data-add-listing="<public listing
  URL>"`, and the module turns that link into an add-to-cart button.
- Adding the first item reveals a floating cart button on the external site.
- Clicking the floating cart button opens a cart preview on the external site.
- The preview shows an **indicative** running total from prices embedded in the
  module. The authoritative total, fees, and availability are computed by the
  canonical ticket page at checkout.
- The preview's Continue button sends the visitor to the canonical ticket page
  with the selected listings and quantities pre-filled, using the same booking
  flow as the existing `/order` page.
- The existing allowed embed hosts setting becomes the single owner-controlled
  allowlist for iframe embedding and order-module loading.

## Non-Goals

- The external widget does not collect attendee PII, custom questions, terms
  acceptance, or payment details.
- The external widget does not create attendees, reserve capacity, or write to
  the database.
- The external widget does not call a server quote/cart API. It prices the cart
  indicatively from embedded data and hands off to the ticket page.
- The external widget does not show an authoritative total or live availability.
  Final pricing, fees, sold-out checks, and every input v1 cannot supply (dates,
  questions, terms, pay-what-you-want, customisable day counts) are handled by
  the canonical ticket page.
- The external widget does not replace `/ticket/:slug`, `/order`, or the
  existing iframe embed snippet.
- The external widget does not support arbitrary third-party checkout styling.
  It owns a small isolated cart UI and then hands off to the real ticket page.

## Owner Experience

The owner adds the module once in their external site template:

```html
<script type="module" src="https://tickets.example.com/order.js"></script>
```

They can also add the same tag in multiple template partials. Browser module
evaluation plus the library's own singleton guard make this safe.

Then they mark links that should add listings:

```html
<a
  href="https://tickets.example.com/ticket/workshop"
  data-add-listing="https://tickets.example.com/ticket/workshop"
>
  Add workshop
</a>
```

The `href` remains the no-JS fallback and should match `data-add-listing`. The
library treats `data-add-listing` as the authoritative listing URL when both are
present.

Optional attributes for the first version:

```html
<a
  href="https://tickets.example.com/ticket/workshop"
  data-add-listing="https://tickets.example.com/ticket/workshop"
  data-add-quantity="2"
>
  Add two workshop tickets
</a>
```

`data-add-quantity` defaults to `1`. Invalid, zero, negative, or fractional
values are ignored and treated as `1`.

## Host Settings

The current setting stores `embed_hosts`, shown in Settings as "Only allow
embedding on these hosts". Keep the stored key for compatibility, but update the
admin copy so the setting means:

> External sites allowed to use embeds and order buttons

The host list controls two behaviours:

1. `frame-ancestors` on embeddable ticket pages.
2. Cross-origin module loading for `/order.js`.

An empty list keeps the existing semantics: external access is allowed from any
site. A non-empty list restricts both behaviours to the same host patterns,
including `*.example.com` wildcard support.

There is no third "API access" behaviour anymore: the widget never makes a
cross-origin request after the module loads, so the allowlist only needs to gate
who can load and frame the content.

## The Module Is Served Dynamically

`/order.js` is **not** a static asset. It is rendered per request because:

- Its CORS headers depend on the mutable `embed_hosts` setting and the request
  `Origin`.
- It embeds a snapshot of the site's public listings (see
  [Embedded Catalog](#embedded-catalog)).

Both of these change when the owner edits settings or listings, so the route
must run inside the normal request pipeline (after settings load), not on the
pre-settings static path.

### Why a module, not a classic script

The owner adds `<script type="module">`, and that matters for enforcement.
Cross-origin **classic** scripts execute without a CORS check — that is how CDN
`<script src>` works — which would let any site load the widget regardless of
`embed_hosts`. A cross-origin **module** script *is* CORS-checked, so when the
server omits `Access-Control-Allow-Origin` for a disallowed origin the browser
refuses to evaluate it. The module form is what makes the allowlist actually
bite. Keep it ESM (`format: "esm"`); do not copy the existing IIFE client
bundles in `scripts/build-static-assets.ts` (which is how `embed.js` is built
today — `format: "iife"`).

**But the owner's tag is not a security boundary.** A disallowed site can ignore
`type="module"` and include the same URL as a classic `<script src>`, which is
not CORS-gated and would run the widget anyway. Two requirements close this:

1. The served bundle **must contain module-only syntax** so it throws when parsed
   as a classic script. esbuild's `esm` output does not guarantee this on its own
   (with no exports it can be classic-compatible), so the bundle must include an
   explicit top-level `export {}` (or a top-level `import` / `import.meta`
   reference). Loaded as a classic script it then fails with a `SyntaxError`
   before any widget code runs.
2. Treat the catalog as public regardless. Even with (1), a determined attacker
   could read the response body off the network; the only thing CORS + module
   syntax actually prevents is *unauthorized widget execution/embedding*, not
   disclosure. That is fine because the catalog is already-public listing data
   (see [Security And Privacy](#security-and-privacy)) — but do not put anything
   in the module body that isn't already public.

Note `import.meta.url` is **not** relied on for origin — the catalog carries
`origin` explicitly — so requirement (1) is purely to force module-only parsing.

### Serving and settings ordering

- `routeStatic` runs before the database is initialized and before
  `prepareRequestEnvironment` loads request settings (`src/features/index.ts`).
  A pre-settings static route would only ever see default or stale `embed_hosts`.
  `/order.js` must be served from a handler that runs **after** settings load.
- `getPrefix("/order.js")` returns `order.js` (the whole path, since there is no
  second slash). Register that prefix in `PREFIX_SETTINGS`; an unlisted prefix
  falls back to `ALL_SNAPSHOT_SETTINGS` and would decrypt the full snapshot just
  to read `embed_hosts`. Scope the entry to only what the module needs:
  `[CONFIG_KEYS.EMBED_HOSTS, CONFIG_KEYS.COUNTRY]` (embed allowlist + currency
  for price formatting). No payment, email, wallet, or SMS secrets are read on
  this path.

### Build integration

- Add `src/ui/client/order.ts` with the static widget logic (link scanning, cart
  state, preview dialog, Continue navigation).
- Bundle it to an ESM artifact under `src/ui/static/` as the module *body*.
- The dynamic handler composes the response by prepending the serialized catalog
  to that bundled body (or substituting a placeholder token). The owner-facing
  logic stays in the bundle; only the catalog JSON varies per request.
- Add `ORDER_JS_PATH = "/order.js"` to asset paths.
- Include the static body in edge asset inlining and cache-busting; the catalog
  is injected at request time.

## Embedded Catalog

At serve time the handler reads the site's public, **listed** listings —
`loadSortedListings(e => e.active && !e.hidden)`, the same predicate the `/order`
and public listings pages use (`src/features/public/order.ts`,
`src/features/public/pages.ts`) — and serializes a small catalog into the module:

```js
// Prepended to the module body at request time
const CATALOG = {
  origin: "https://tickets.example.com",
  currency: "GBP",       // settings.currency, derived from COUNTRY
  decimalPlaces: 2,       // getDecimalPlaces(currency); minor-units divisor = 10 ** places
  generatedAt: "2026-06-28T20:00:00Z",
  listings: {
    workshop: {
      id: 12,
      slug: "workshop",
      name: "Workshop",
      unitPrice: 1500,            // minor units (pence)
      variablePrice: false,
    },
    meal: {
      id: 13,
      slug: "meal",
      name: "Meal",
      unitPrice: 2000,            // minimum for PWYW; a "from" price
      variablePrice: true,        // requires a checkout-only input (see below)
    },
  },
};
```

Rules:

- The catalog is keyed by slug for O(1) lookup from a `data-add-listing` URL.
- Prices are **minor-unit integers** (`Listing.unit_price`, `src/shared/types.ts`).
- The client formats all displayed money — unit price, line totals, and the
  subtotal — itself, using `CATALOG.currency` and `CATALOG.decimalPlaces`. It must
  mirror the server's `formatCurrency` (`src/shared/currency.ts`) so output
  matches the canonical pages: convert `minorUnits / 10 ** decimalPlaces`, then
  `new Intl.NumberFormat("en", { style: "currency", currency, trailingZeroDisplay:
  "stripIfInteger" }).format(...)`. This is a single `Intl` call mirroring one
  helper, not a reimplementation of checkout math. (An earlier draft forbade
  client formatting, which made `quantity × unitPrice` line totals
  unrenderable — that rule is dropped.)
- `variablePrice` is `true` when the listing requires an input the v1 widget
  cannot supply, so a final price can't be shown. The precise conditions, each
  confirmed against the booking form:
  - `listing_type === "daily"` — requires a date (`listing_type` is
    `"standard" | "daily"`; the date selector is gated on `"daily"`, not on a
    date merely existing — `src/features/public/ticket-payment.ts`).
  - `customisable_days` — requires a day-count choice (`resolveDayCount`).
  - `can_pay_more` — pay-what-you-want; `unit_price` is the minimum, shown as a
    "from" price.
  - The listing has a **required answer-priced question** — an answer carries a
    price `modifier_id` (`listing_questions` + answer modifiers,
    `src/shared/db/questions.ts`, `src/shared/db/migrations/schema.ts`), so the
    answer changes the price.
  For these the cart shows "Price set at checkout" and excludes them from the
  indicative subtotal. A *required but non-priced* question does **not** set
  `variablePrice` — the price is still known; the answer is just collected at
  checkout like everything else the widget defers.
- **Only active, listed listings are included** (`active && !hidden`).
  Hidden/unlisted listings (privacy) and inactive/closed listings (unbookable)
  are omitted; a `data-add-listing` to either falls back to its plain `href`
  (see [Security And Privacy](#security-and-privacy)).
- `generatedAt` is informational. The catalog can go stale between page loads;
  that is accepted (listings change slowly and a page refresh re-fetches the
  module). It is **not** a signed token and the module never refetches to
  refresh it.

The catalog is identical for every origin; the only per-origin variance in the
response is the CORS header.

Note on accuracy: the indicative subtotal is `quantity × unitPrice` per
fixed-price item. It does **not** apply quantity/tier price modifiers or the
booking fee — those are resolved at checkout — so the subtotal is a lower-bound
estimate, which the caveat in [Pricing](#pricing) makes explicit.

## Header Contract

`/order.js` is fetched as a cross-origin module, so it must send CORS headers
when requested from an allowed origin. It is a simple `GET` — there is no
preflight and no `OPTIONS` handler.

For allowed origins:

```http
Content-Type: application/javascript; charset=utf-8
Access-Control-Allow-Origin: https://www.example.com
Vary: Origin
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: no-store
```

For an empty allowlist (any site allowed):

```http
Content-Type: application/javascript; charset=utf-8
Access-Control-Allow-Origin: *
Vary: Origin
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: no-store
```

When an origin is not allowed, omit `Access-Control-Allow-Origin`. The browser
then refuses to evaluate the module, and the marked links fall back to ordinary
navigation to the ticket page.

`Vary: Origin` and a non-cacheable `Cache-Control` are required: the response
varies by request `Origin` and embeds a catalog that depends on mutable
settings, so a cached copy could serve a stale `Access-Control-Allow-Origin`
after the owner tightens the allowlist. (A short `max-age` is acceptable in place
of `no-store` if a brief staleness window is fine; the immutable static-asset
cache is not.) The security stakes are lower than for the old API design — no
private data is gated, the module only enhances links to already-public pages —
but keeping the allowlist responsive is still worthwhile.

## Browser Behaviour

On module evaluation:

1. Read the tickets origin and catalog from the embedded `CATALOG`.
2. Register a singleton cart controller for that origin.
3. Load any stored cart and **reconcile it against the current catalog**: drop
   stored slugs that are no longer present (the owner hid, deactivated, renamed,
   or removed the listing since the cart was saved). Only catalog-resolved items
   survive — this keeps the count, subtotal, and Continue URL consistent, since
   the Continue URL is built from current catalog slugs and ids and a dropped
   slug has no id. If items were dropped, surface a brief notice in the preview.
4. Scan the document for `a[data-add-listing]`.
5. Attach click handlers to links whose listing is in the catalog.
6. Start a `MutationObserver` so links added after page load are enhanced.

The controller only enhances a link whose `data-add-listing` URL:

- is an absolute URL,
- has the same origin as `CATALOG.origin`,
- matches `/ticket/<single-slug>` with no `+` multi-listing bundle, and
- resolves to a slug present in `CATALOG.listings`.

Links that do not resolve to a catalog slug are left alone — including
hidden/unlisted listings, which are intentionally absent from the catalog and so
simply keep their no-JS `href`. In development builds the module may log a
console warning; production should avoid noisy logs on owner sites.

When a visitor clicks an enhanced link:

1. Prevent default navigation.
2. Add the listing to the cart, incrementing quantity if already present.
3. Reveal or update the floating cart button.
4. Briefly animate the cart button to acknowledge the add.
5. Recompute the indicative subtotal locally if the preview panel is open.

The cart is stored in `sessionStorage`, keyed by tickets origin:

```text
tickets:external-order:v1:https://tickets.example.com
```

Stored data contains slugs and quantities only. It contains no contact details,
answers, payment state, cookies, or tokens.

## Cart UI

The module creates exactly one floating cart button per tickets origin. Multiple
copies of the same module must reuse the existing controller and UI.

Button requirements:

- Hidden while the cart is empty.
- Fixed in the lower-right corner by default.
- Shows a cart icon and the total item quantity.
- Uses `button`, not `a`, because it opens an in-page preview.
- Has an accessible label such as `View ticket cart, 3 items`.

Preview requirements:

- Opens as an accessible modal dialog.
- Moves focus into the dialog when opened.
- Restores focus to the cart button when closed.
- Closes on Escape and on explicit close button.
- Lists selected items with quantity steppers and remove buttons.
- Shows each fixed-price item's unit price and line total (quantity × `unitPrice`,
  formatted client-side per [Embedded Catalog](#embedded-catalog)), and "Price set
  at checkout" for variable-price listings.
- Shows an indicative subtotal with a clear caveat (see [Pricing](#pricing)).
- Shows a Continue button only when the cart contains at least one
  catalog-resolved item (after the reconciliation in Browser Behaviour).
- If reconciliation dropped any stored item, shows a brief "some items are no
  longer available" notice.

Use Shadow DOM for the widget shell so owner CSS does not accidentally break the
cart. Render the summary markup in the widget itself with a small copy of the
existing `.order-summary` rules; do not reuse the full site stylesheet on the
external page.

## Pricing

The widget total is **indicative**, computed entirely client-side from the
embedded catalog. There is no checkout math in the widget and no server quote.

- For fixed-price listings the line total is `quantity × unitPrice`, formatted
  client-side from `CATALOG.currency` / `CATALOG.decimalPlaces` (see
  [Embedded Catalog](#embedded-catalog)).
- Variable-price listings (`listing_type === "daily"`, pay-what-you-want,
  customisable days, or a required answer-priced question) show "Price set at
  checkout" and are excluded from the subtotal.
- The subtotal is labelled to set expectations, e.g.:

```html
<p class="order-summary-message">
  Subtotal — final total, fees, and availability are confirmed at checkout.
</p>
```

This deliberately avoids replicating the booking engine (tiers, fees, rounding,
sold-out logic) in JavaScript. The single source of truth for the authoritative
total is the canonical ticket page, which the visitor reaches via Continue. The
widget only formats raw unit prices; matching the canonical display is a matter
of mirroring one `Intl.NumberFormat` call (`formatCurrency`,
`src/shared/currency.ts`), not reproducing pricing logic. Quantity/tier modifiers
and the booking fee are intentionally not applied here — the subtotal is a
lower-bound estimate.

## Continue URL

The external Continue button navigates the top-level window to the canonical
ticket page with quantities pre-filled. The client builds the URL from the
catalog using selected slugs and ids:

```text
https://tickets.example.com/ticket/workshop+meal?q_12=2&q_13=1
```

This is the exact form the existing `/order` gallery handoff produces
(`bookingUrlFor`, `src/features/public/order.ts`): slugs joined with `+`
(`parseSlugs`, `src/features/public/types.ts`) and a `q_<listingId>` query param
per listing. The ticket GET page reads those `q_<id>` params to pre-fill
quantities (`parseQuantityPrefill`, `src/features/public/ticket-submit.ts`).
Note the prefill param is `q_<id>`, deliberately **not** the form's submit field
`quantity_<listingId>` — keep them distinct. The ticket page then collects
attendee details, required fields, terms, pay-what-you-want prices, dates, day
counts, and payment through the normal booking form — i.e. everything the widget
defers.

The external widget must not submit directly to `/ticket/:slug` because it does
not hold a CSRF token and does not collect the full booking form. It only
navigates there.

## Error Handling

Client-side only — there is no server endpoint to fail:

- If the module cannot parse a link, leave the link as a normal link.
- If a `data-add-listing` slug is not in the catalog, leave the link alone.
- If storage is unavailable, keep an in-memory cart for the current page.
- If the module is blocked (disallowed origin / CORS), it never evaluates, so
  the marked links simply work as ordinary links.

Server-side, the only failure surface is rendering `/order.js`:

- Never expose stack traces, decrypted settings, or private listing data in the
  module body.
- Build the catalog with existing escaping/serialization helpers so listing
  names cannot break out of the embedded JSON/JS.

## Security And Privacy

- There is no new server endpoint. `/order.js` is a read-only, public,
  catalog-bearing asset.
- The catalog contains only public listing data (slug, id, name, minor-unit unit
  price) for active, **listed** listings (`active && !hidden`) — the same data the
  public listings page already exposes.
- Hidden/unlisted listings are never embedded, so the module cannot be used to
  enumerate them. A `data-add-listing` pointing at a hidden listing is simply not
  enhanced; its `href` still opens the real ticket page (the listing remains
  reachable by its exact URL, exactly as today). This preserves the
  progressive-enhancement promise without making unlisted listings discoverable.
- No cookies are read or set; `sessionStorage` holds slugs and quantities only.
- `embed_hosts` gates module loading via CORS on a module script. This prevents
  arbitrary sites from embedding the widget, though it gates no private data.
- The allowlist check uses the request `Origin` header, not `Referer`.
- Keep `frame-ancestors` on ticket pages exactly as strict as the owner setting
  requires.
- `generatedAt` is not a security token; do not treat module freshness as an
  authorization signal.

## Compatibility

Existing snippets remain valid:

```html
<script async src="https://tickets.example.com/embed.js" data-listings="workshop"></script>
```

The new module uses a new path:

```html
<script type="module" src="https://tickets.example.com/order.js"></script>
```

Both may exist on the same external site. The iframe embed creates booking forms
in place; the external order library enhances links and creates a floating cart.
They should not share global state.

## Testing Plan

Server tests:

- `/order.js` for an allowed origin sends `Access-Control-Allow-Origin`,
  `Vary: Origin`, and a non-cacheable `Cache-Control`, and embeds the catalog.
- `/order.js` for a disallowed origin sends no permissive CORS header.
- The embedded catalog includes active listed listings with id, slug, name,
  minor-unit `unitPrice`, and the `currency`/`decimalPlaces` descriptor.
- Hidden/unlisted and inactive (`active === false`) listings are excluded.
- `variablePrice` is set for a `daily` listing, a `customisable_days` listing, a
  `can_pay_more` listing, and a listing with a required answer-priced question;
  it is **not** set for a fixed-price listing that merely has a non-priced
  required question.
- The served module body contains module-only syntax (e.g. `export {}`) so it
  throws if loaded as a classic script.
- Rendering `/order.js` loads only the `[EMBED_HOSTS, COUNTRY]` settings bundle,
  not payment/email/wallet/SMS secrets.
- Listing names with quotes/markup are safely escaped in the embedded catalog.

Client tests:

- Multiple identical module executions create one cart button.
- Links are enhanced only when `data-add-listing` resolves to a catalog slug at
  the module origin; unknown and hidden slugs are left as plain links.
- Clicks prevent default only for enhanced links.
- Re-clicking the same link increments quantity.
- The cart survives same-tab page navigation through `sessionStorage`.
- A stored slug absent from the current catalog is dropped on load, and Continue
  is hidden when no catalog-resolved item remains.
- The indicative subtotal sums fixed-price line totals (formatted client-side)
  and excludes variable-price items, which show "Price set at checkout".
- Client-formatted prices match the server's `formatCurrency` output for the
  same minor-unit amount and currency.
- The Continue button builds and navigates to
  `/ticket/<slugs>?q_<id>=<qty>` from the catalog.
- The dialog meets keyboard basics: focus enters, Escape closes, focus returns.

End-to-end browser test:

- Render an external fixture page with an allowed origin.
- Load `/order.js` as a module.
- Click two external `data-add-listing` links.
- Assert the floating cart appears with count 2.
- Open the preview and assert the indicative subtotal is shown with the
  checkout caveat.
- Click Continue and assert the browser reaches `/ticket/<slugs>` with the
  expected `q_<listingId>` query params.

## Implementation Slices

1. Rename the admin setting copy from iframe-only embedding to external-site
   access, keeping the `embed_hosts` storage key.
2. Add shared allowed-origin/CORS helpers on top of `parseEmbedHosts` and
   `buildFrameAncestors`.
3. Add the dynamic `/order.js` handler: runs after settings load, gates CORS on
   `embed_hosts` with `Vary: Origin` and `no-store`, and registers the `order.js`
   prefix in `PREFIX_SETTINGS` as `[EMBED_HOSTS, COUNTRY]`.
4. Build the embedded catalog via `loadSortedListings(e => e.active && !e.hidden)`;
   emit id, slug, name, minor-unit `unitPrice`, and a top-level
   `currency`/`decimalPlaces` descriptor (from `settings.currency` /
   `getDecimalPlaces`). Compute `variablePrice` from `listing_type === "daily"`,
   `customisable_days`, `can_pay_more`, or a required answer-priced question.
   Escape via existing serialization helpers.
5. Build `src/ui/client/order.ts` (ESM, with a top-level `export {}` so it cannot
   run as a classic script): catalog-driven link scanning, singleton guard,
   `sessionStorage` cart with on-load reconciliation against the catalog,
   client-side currency formatting mirroring `formatCurrency`, indicative
   subtotal, preview dialog, and Continue navigation. Compose the served module
   from this bundle plus the injected catalog.
6. Add owner-facing snippet text to the settings or listing admin UI.
7. Add the server, client, and e2e tests above.

## Future Extensions

- **Authoritative pricing (opt-in).** If exact totals, fees, or live availability
  are ever needed inside the widget, add an opt-in server quote endpoint that
  reuses the `/calculate` quote path. This was considered for v1 and dropped in
  favour of the AJAX-free embedded-catalog design; it remains the documented
  escape hatch if indicative pricing proves insufficient.
- `data-add-date` or a widget-level date selector for dated listings.
- Support for pay-what-you-want inputs in the external preview.
- Support for add-ons and promo codes in the external preview.
- A custom element API such as `<tickets-cart-button>`.
- Analytics callbacks dispatched as DOM events on add, remove, preview, and
  continue.
