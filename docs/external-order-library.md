# External Order Library

## Purpose

Give site owners a small JavaScript module they can add to an external website
so ordinary links on that site become "add to cart" controls for tickets hosted
by this app.

The library is a progressive enhancement over real public listing links. If the
module fails to load, JavaScript is disabled, or the external site is not
allowed by the owner's settings, each link still opens its listing's normal
ticket page.

## Goals

- A site owner can add one module script tag to their external site template, or
  add the same tag multiple times without duplicate UI or duplicate handlers.
- A site owner can mark an external link with `data-add-listing="<public listing
  URL>"`, and the module turns that link into an add-to-cart button.
- Adding the first item reveals a floating cart button on the external site.
- Clicking the floating cart button opens a cart preview on the external site.
- The preview uses the same pricing and order-summary infrastructure as the
  existing booking form running total.
- The preview's Continue button sends the visitor to the canonical ticket page
  with the selected listings and quantities pre-filled, using the same booking
  flow as the existing `/order` page.
- The existing allowed embed hosts setting becomes the single owner-controlled
  allowlist for iframe embedding, module loading, and quote API access.

## Non-Goals

- The external widget does not collect attendee PII, custom questions, terms
  acceptance, or payment details.
- The external widget does not create attendees, reserve capacity, or write to
  the database.
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

The host list controls three behaviours:

1. `frame-ancestors` on embeddable ticket pages.
2. Cross-origin module loading for `/order.js`.
3. Cross-origin quote and cart-resolution requests used by `/order.js`.

An empty list keeps the existing semantics: external access is allowed from any
site. A non-empty list restricts all three behaviours to the same host patterns,
including `*.example.com` wildcard support.

## Header Contract

Module scripts are CORS-checked by browsers, so `/order.js` must send CORS
headers when requested from an allowed external origin.

For allowed origins:

```http
Access-Control-Allow-Origin: https://www.example.com
Vary: Origin
Cross-Origin-Resource-Policy: cross-origin
```

For an empty allowlist:

```http
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
```

For quote and cart-resolution endpoints:

```http
Access-Control-Allow-Origin: https://www.example.com
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: content-type
Vary: Origin
```

These endpoints must not require cookies, must not set cookies, and must not use
credentialed CORS. The client always sends `credentials: "omit"`.

When an origin is not allowed, API endpoints return `403` with no permissive
CORS header. Static module requests can simply omit `Access-Control-Allow-Origin`,
which makes the browser block evaluation.

## Script Asset

Serve a new module asset:

```text
GET /order.js
```

Keep the existing `/embed.js` iframe loader unchanged for backwards
compatibility. The new asset should have its own path because its job is
different: it enhances links and manages a floating cart rather than replacing a
script tag with an iframe.

Build integration:

- Add `src/ui/client/order.ts`.
- Bundle it to `src/ui/static/order.js`.
- Add `ORDER_JS_PATH = "/order.js"` to asset paths.
- Add `GET /order.js` to static routes.
- Include it in edge asset inlining and cache-busting.

## Browser Behaviour

On module evaluation:

1. Resolve the tickets origin from `import.meta.url`.
2. Register a singleton cart controller for that origin.
3. Scan the document for `a[data-add-listing]`.
4. Attach click handlers to valid links.
5. Start a `MutationObserver` so links added after page load are enhanced.

The controller only enhances links whose `data-add-listing` URL:

- is an absolute URL,
- has the same origin as the module,
- matches `/ticket/<single-slug>`, and
- contains no `+` multi-listing slug bundle.

Invalid links are left alone. In development builds the module may log a console
warning; production should avoid noisy logs on owner sites.

When a visitor clicks an enhanced link:

1. Prevent default navigation.
2. Add the listing to the cart, incrementing quantity if already present.
3. Reveal or update the floating cart button.
4. Briefly animate the cart button to acknowledge the add.
5. Request a fresh preview in the background if the preview panel is open.

The cart is stored in `sessionStorage`, keyed by tickets origin:

```text
tickets:external-order:v1:https://tickets.example.com
```

Stored data contains public listing URLs/slugs and quantities only. It contains
no contact details, answers, payment state, cookies, or tokens.

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
- Debounces preview refreshes after quantity changes.
- Shows the server-rendered order summary fragment.
- Shows a Continue button when the cart contains at least one valid item.

Use Shadow DOM for the widget shell so owner CSS does not accidentally break the
cart. Server-rendered order-summary HTML can be inserted into the shadow root
and styled with a small copy of the existing `.order-summary` rules. Do not
reuse the full site stylesheet on the external page.

## Server Contracts

Add a small external-order API under a public prefix:

```text
POST /api/external-order/preview
OPTIONS /api/external-order/preview
```

Request body:

```json
{
  "items": [
    {
      "url": "https://tickets.example.com/ticket/workshop",
      "quantity": 2
    }
  ]
}
```

Response body:

```json
{
  "ok": true,
  "items": [
    {
      "url": "https://tickets.example.com/ticket/workshop",
      "slug": "workshop",
      "listingId": 12,
      "name": "Workshop",
      "quantity": 2,
      "maxPurchasable": 8
    }
  ],
  "summaryHtml": "<div class=\"table-scroll\">...</div>",
  "continueUrl": "https://tickets.example.com/ticket/workshop?q_12=2"
}
```

The endpoint resolves public listing URLs to active listings, normalizes
quantities against current availability, prices the cart through the same
quote path used by `/calculate/:slug`, and returns the same order-summary
fragment rendered by `orderSummary`.

If requested quantities exceed availability, the response should normalize the
quantity down and include a user-facing message in `summaryHtml`. The client then
updates its cart to match the server response.

If a listing is closed, sold out, hidden, unknown, or from the wrong origin, the
response omits it from `items` and includes a clear message in `summaryHtml`.
The client removes omitted items from its cart.

If the selected cart needs more pricing inputs before an accurate quote is
possible, for example a dated listing that needs a date, the response still
returns a `continueUrl` and a message fragment such as:

```html
<p class="order-summary-message">Continue to choose a date and see the final total.</p>
```

The first version does not render date, question, add-on, promo-code, or
pay-what-you-want controls inside the external widget. Those remain on the
canonical ticket page.

## Pricing Reuse

Do not duplicate checkout math in the widget endpoint.

Refactor the current `/calculate/:slug` flow so both `/calculate/:slug` and
`/api/external-order/preview` call the same internal quote function:

```text
selected listings + form-like pricing fields
  -> prepareOrder
  -> checkSoldOutTiers
  -> checkAvailability
  -> orderSummary / orderSummaryMessage
```

The external endpoint builds a form-like input from cart items:

```text
quantity_<listingId>=<quantity>
```

It may include future optional pricing fields, but v1 only sends quantities.
No PII fields are accepted or needed.

## Continue URL

The external Continue button navigates the top-level window to the returned
`continueUrl`.

The URL is the canonical ticket page with quantities pre-filled:

```text
https://tickets.example.com/ticket/workshop+meal?q_12=2&q_13=1
```

This mirrors the existing `/order` gallery handoff: the external page selects a
cart, then the ticket page collects attendee details, required fields, terms,
and payment through the normal booking form.

The external widget must not submit directly to `/ticket/:slug` because it does
not hold a CSRF token and does not collect the full booking form.

## Error Handling

Client-side failures:

- If the module cannot parse a link, leave the link as a normal link.
- If preview fetch fails, keep the cart and show a compact retry message.
- If storage is unavailable, keep an in-memory cart for the current page.
- If the server returns `403`, disable enhanced behaviour and leave existing
  links usable.

Server-side failures:

- Return `400` for malformed JSON or invalid item shapes.
- Return `403` for disallowed origins.
- Return `200` with an order-summary message for normal cart problems such as
  sold-out listings, missing listings, or no selected items.
- Never expose stack traces, decrypted settings, or private listing data.

## Security And Privacy

- The preview endpoint is read-only and creates no reservations.
- The preview endpoint ignores cookies and does not authenticate as an admin or
  attendee.
- The request body contains public listing URLs and quantities only.
- No PII is stored by the widget.
- The server must build all summary HTML with existing escaping/rendering
  helpers.
- The allowlist check uses the request `Origin` header, not `Referer`.
- For `OPTIONS`, validate the requested origin before returning CORS headers.
- Keep `frame-ancestors` on ticket pages exactly as strict as the owner setting
  requires.

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

- Allowed origin receives CORS headers for `/order.js`.
- Disallowed origin receives no permissive CORS headers.
- `OPTIONS /api/external-order/preview` validates origin and headers.
- Preview rejects malformed JSON with `400`.
- Preview rejects disallowed origins with `403`.
- Preview resolves a public listing URL to the correct listing id and slug.
- Preview returns the same `orderSummary` fragment as `/calculate` for a simple
  quantity-only cart.
- Preview normalizes over-large quantities and reports the normalization.
- Continue URL uses canonical slugs and `q_<listingId>` quantities.
- Closed, sold-out, hidden, and unknown listings are not silently accepted.

Client tests:

- Multiple identical module executions create one cart button.
- Links are enhanced only when `data-add-listing` is valid for the module
  origin.
- Clicks prevent default only for enhanced links.
- Re-clicking the same link increments quantity.
- The cart survives same-tab page navigation through `sessionStorage`.
- Quantity changes debounce preview refresh.
- Server-normalized item quantities update client state.
- The Continue button navigates to the server-returned URL.
- The dialog meets keyboard basics: focus enters, Escape closes, focus returns.

End-to-end browser test:

- Render an external fixture page with an allowed origin.
- Load `/order.js` as a module.
- Click two external `data-add-listing` links.
- Assert the floating cart appears with count 2.
- Open the preview and assert the order summary contains the priced total.
- Click Continue and assert the browser reaches `/ticket/<slugs>` with the
  expected `q_<listingId>` query params.

## Implementation Slices

1. Rename the admin setting copy from iframe-only embedding to external-site
   access, keeping the `embed_hosts` storage key.
2. Add shared allowed-origin/CORS helpers on top of `parseEmbedHosts` and
   `buildFrameAncestors`.
3. Add `/order.js` as a module asset with CORS headers.
4. Extract the current quote rendering behind `/calculate/:slug` into a shared
   read-only quote function.
5. Add `POST /api/external-order/preview`.
6. Build `src/ui/client/order.ts` with singleton link scanning, cart state,
   preview dialog, and Continue navigation.
7. Add owner-facing snippet text to the settings or listing admin UI.
8. Add the server, client, and e2e tests above.

## Future Extensions

- `data-add-date` or a widget-level date selector for dated listings.
- Support for pay-what-you-want inputs in the external preview.
- Support for add-ons and promo codes in the external preview.
- A custom element API such as `<tickets-cart-button>`.
- Analytics callbacks dispatched as DOM events on add, remove, preview, and
  continue.
