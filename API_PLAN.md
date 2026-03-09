# Public API Implementation Plan

## Context

The ticket reservation system has excellent separation between business logic (DB layer returns plain objects) and HTTP handling (routes format responses). Adding a public JSON API is largely a matter of creating thin handler wrappers around existing functions, plus a small middleware tweak to accept JSON POST requests on API paths.

The API covers: listing events, event details, availability checking, and creating bookings (returning a Stripe checkout URL for paid events or a ticket token for free events). No admin endpoints — the double-wrapped encryption key makes that impractical.

## Security Analysis

**Safe by design — no new attack surface:**

1. **Data exposure matches web exactly** — API returns only the same derived values the web UI renders to HTML: `isSoldOut` (boolean), `isClosed` (boolean), `maxPurchasable` (number). Raw `max_attendees`, `attendee_count`, and `closes_at` are never exposed. If the web returns a 404, so does the API.

2. **No authentication needed** — The web booking form is also unauthenticated. CSRF on the web prevents cross-site forgery but not direct submissions; a bot can already scrape a CSRF token and automate bookings. The API is equivalent in security posture.

3. **Capacity protection is atomic** — `createAttendeeAtomic()` uses an atomic SQL INSERT with capacity check, preventing overbooking regardless of concurrent request volume.

4. **Stripe checkout URLs are safe to return** — Sessions are time-limited, payment-specific, and Stripe handles all checkout security. This is standard Stripe integration.

5. **Domain validation still applies** — External API calls target the real domain, so the Host header matches `ALLOWED_DOMAIN`. No bypass needed.

6. **Input validation reused** — Same `validateTicketFields()` as the web form, preventing any validation bypass.

7. **No PII leakage** — API exposes no attendee data. Booking submissions contain PII (name, email) but that's identical to the web form, and it's encrypted at rest via `createAttendeeAtomic()`.

8. **CORS `*` is safe** — No cookies/sessions/auth tokens on API routes, so unrestricted origin access has no security implications.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | List active, non-hidden events |
| `GET` | `/api/events/:slug` | Single event detail + availability info |
| `GET` | `/api/events/:slug/availability` | Check availability (supports `?quantity=N&date=YYYY-MM-DD`) |
| `POST` | `/api/events/:slug/book` | Create booking → `{ checkoutUrl }` or `{ ticketToken, ticketUrl }` |
| `OPTIONS` | `/api/*` | CORS preflight |

All error responses: `{ error: "message" }` with appropriate HTTP status code.

## Public Event Shape

The API exposes **only what the web UI renders** — derived values, not raw internals:

```typescript
type PublicEvent = {
  name: string;             // event title
  slug: string;             // URL identifier
  description: string;      // markdown description
  date: string | null;      // formatted date or null
  location: string | null;  // venue or null
  imageUrl: string | null;  // image URL or null
  unitPrice: number;        // price in minor units (0 for free)
  canPayMore: boolean;      // allows custom pricing
  maxPrice: number;         // max custom price (minor units)
  nonTransferable: boolean; // ticket transfer policy
  fields: string;           // required contact fields ("email", "email,phone", etc.)
  eventType: "standard" | "daily";
  isSoldOut: boolean;       // derived: max_attendees - attendee_count <= 0
  isClosed: boolean;        // derived: closes_at in the past
  maxPurchasable: number;   // derived: min(max_quantity, spots_remaining), 0 if sold out/closed
  availableDates?: string[];// daily events only: bookable dates
};
```

**Explicitly excluded** (internal/admin data): `id`, `max_attendees`, `attendee_count`, `closes_at`, `slug_index`, `group_id`, `created`, `thank_you_url`, `webhook_url`, `bookable_days`, `minimum_days_before`, `maximum_days_after`, `hidden`, `active`, `max_quantity`.

## Files to Create

### 1. `src/routes/api.ts` — API route handlers

**`toPublicEvent()`** — serializes `EventWithCount` into the `PublicEvent` shape above, computing `isSoldOut`, `isClosed`, and `maxPurchasable` from raw fields (same logic as `src/templates/public.tsx` lines 304-309).

**CORS** — `apiJsonResponse()` wrapper adds `access-control-allow-origin: *`, `access-control-allow-methods`, `access-control-allow-headers`. `handleOptions()` returns 204 with CORS headers.

**Handlers** — all reuse existing business logic:

1. **`handleListEvents`** — `getAllEvents()` (cached) → filter `active && !hidden` → `sortEvents()` → map `toPublicEvent()`

2. **`handleGetEvent`** — `getEventBySlug()` → 404 if missing/inactive/hidden → `toPublicEvent()` with `availableDates` for daily events

3. **`handleCheckAvailability`** — parse `quantity`/`date` from query params → `hasAvailableSpots()` → `{ available: boolean }`
   - Does NOT expose `spotsRemaining` (web doesn't show exact remaining count)

4. **`handleBook`** — parse JSON body → validate via `validateTicketFields()` (convert JSON→URLSearchParams) → check `isRegistrationClosed()`:
   - **Paid**: `hasAvailableSpots()` → `provider.createCheckoutSession()` → `{ checkoutUrl }`
   - **Free**: `createAttendeeAtomic()` → `{ ticketToken, ticketUrl }` or 409 on capacity exceeded
   - Calls `logAndNotifyRegistration()` on success (same webhooks as web flow)
   - No CSRF needed — no cookies/sessions involved

**Route definitions** using `defineRoutes()` + `createRouter()`.

### 2. `test/routes/api.test.ts` — Tests

Using `createTestDb`, `resetDb`, `mockRequest` from `#test-utils`, testing through `handleRequest()`:
- GET /api/events: JSON array, filters hidden/inactive, CORS headers, no internal fields exposed
- GET /api/events/:slug: event details, 404 for missing/inactive/hidden, dates for daily
- GET /api/events/:slug/availability: boolean availability, respects quantity/date params
- POST /api/events/:slug/book: free→ticketToken, paid→checkoutUrl, field validation, 409 capacity, content-type validation
- OPTIONS: 204 with CORS headers
- 100% coverage required

## Files to Modify

### 3. `src/routes/middleware.ts` — Accept JSON on API paths

Update `isJsonApiPath()` (line 133):

```typescript
const API_PATH_PATTERN = /^\/api\//;

export const isJsonApiPath = (path: string): boolean =>
  SCAN_API_PATTERN.test(path) || API_PATH_PATTERN.test(path);
```

### 4. `src/routes/index.ts` — Register API route group

Add lazy loader + prefix dispatch entry (same pattern as all other route groups):

```typescript
const loadApiRoutes = once(async () => {
  const { routeApi } = await import("#routes/api.ts");
  return routeApi;
});
```

Add `api: lazyRoute(loadApiRoutes)` to `prefixHandlers`.

### 5. `deno.json` — Add import map entry if needed

Check if `#routes/` wildcard pattern covers `#routes/api.ts` automatically.

### 6. Admin guide page — Document the API

Add API documentation section to the admin guide page at `/admin/guide`, documenting all endpoints with example requests/responses so admins know the API exists and can share it with integrators.

## Key Reused Functions

| Function | File | Purpose |
|----------|------|---------|
| `getAllEvents()` | `src/lib/db/events.ts` | Cached event listing |
| `getEventBySlug()` | `src/lib/db/events.ts` | Single event lookup |
| `hasAvailableSpots()` | `src/lib/db/attendees.ts` | Availability check |
| `createAttendeeAtomic()` | `src/lib/db/attendees.ts` | Atomic registration |
| `getActivePaymentProvider()` | `src/lib/payments.ts` | Payment provider |
| `createCheckoutSession()` | Provider interface | Stripe checkout URL |
| `sortEvents()` | `src/lib/db/events.ts` | Event ordering |
| `getAvailableDates()` | `src/lib/db/events.ts` | Daily event dates |
| `isRegistrationClosed()` | `src/routes/public.ts` | Closure check |
| `validateTicketFields()` | `src/routes/public.ts` | Field validation |
| `logAndNotifyRegistration()` | `src/routes/public.ts` | Webhook notifications |
| `jsonResponse()` | `src/routes/utils.ts` | JSON response builder |
| `defineRoutes()` / `createRouter()` | `src/routes/router.ts` | Route definition |
| `requiresPayment()` | `src/routes/public.ts` | Payment check |
| `parseQuantity()` | `src/routes/public.ts` | Quantity parsing |

## Verification

1. `deno task precommit` — typecheck, lint, all tests pass
2. `deno task test:coverage` — 100% coverage on new files
3. Manual `curl` testing of all endpoints
