# API-First Refactor Plan

## Principle
Extract business logic from route handlers into reusable functions, then expose those functions via admin API endpoints. Each phase is independently shippable. No existing behavior changes.

---

## Phase 1: Extract business logic from tangled handlers

### 1a. `src/lib/attendees-actions.ts` (new file)
Extract from `src/routes/admin/attendees.ts`:

- **`isIncompleteAttendee(attendee, event)`** → boolean
  - Currently inline in `handleDeleteIncomplete` (~3 lines of logic)

- **`refundAttendeesBatch(attendees, provider)`** → `{ refunded: number, failed: number }`
  - Currently a loop inside `processRefundAll` with counter tracking

- **`calculateSpotsNeeded(oldQty, newQty, oldEventId, newEventId)`** → number
  - Currently inline in `editAttendeeHandler` with conditional logic

### 1b. `src/lib/settings-actions.ts` (new file)
Extract from `src/routes/admin/settings.ts`:

- **`configureStripe(secretKey, existingKey, domain)`** → `{ ok: true } | { ok: false, error: string }`
  - Currently ~60 lines inline: key format detection, webhook setup, multi-field storage

- **`configureSquare(token, locationId, sandbox, existingToken)`** → same result type
  - Currently ~40 lines inline

- **`configureAppleWallet(input)`** → same result type
  - Currently ~60 lines inline: all-clear detection, required field checks, PEM validation

- **`configureGoogleWallet(input)`** → same result type
  - Currently ~70 lines inline

- **`validateEmailTemplates(subject, html, text)`** → `string | null`
  - Currently two inline loops doing length + syntax validation

### 1c. Minor extraction in `src/routes/admin/events.ts`
- **`validateEventSlug(slug, excludeId?)`** → `string | null`
  - Currently a lambda inside the route handler

### After Phase 1
- All route handlers become: parse input → call extracted function → format response
- All existing behavior unchanged
- Extracted functions are independently testable
- Tests updated to cover extracted functions directly

---

## Phase 2: Admin API routes

### New file: `src/routes/admin/api.ts`

Uses existing infrastructure: `withAuthJson`, `defineRoutes`, `createRouter`, `jsonResponse`.

Auth: same session cookie auth as admin UI. CSRF via `x-csrf-token` header (already supported by `withAuthJson`).

### Priority endpoints (highest value for external tooling):

**Events CRUD:**
- `GET /api/admin/events` → list all events with counts
- `GET /api/admin/events/:eventId` → single event detail
- `POST /api/admin/events` → create event (JSON body)
- `PUT /api/admin/events/:eventId` → update event
- `DELETE /api/admin/events/:eventId` → delete event (requires `{ confirmName }`)
- `POST /api/admin/events/:eventId/deactivate` → deactivate
- `POST /api/admin/events/:eventId/reactivate` → reactivate

**Attendees:**
- `GET /api/admin/events/:eventId/attendees` → list attendees (decrypted)
- `POST /api/admin/events/:eventId/attendees` → add attendee manually
- `PUT /api/admin/attendees/:attendeeId` → edit attendee
- `DELETE /api/admin/attendees/:attendeeId` → delete attendee
- `POST /api/admin/attendees/:attendeeId/checkin` → toggle check-in
- `POST /api/admin/attendees/:attendeeId/refund` → refund single
- `POST /api/admin/events/:eventId/refund-all` → batch refund

**Groups:**
- `GET /api/admin/groups` → list groups
- `POST /api/admin/groups` → create group
- `PUT /api/admin/groups/:groupId` → update group
- `DELETE /api/admin/groups/:groupId` → delete group

**Dashboard/Read-only:**
- `GET /api/admin/dashboard` → dashboard summary data
- `GET /api/admin/events/:eventId/activity` → activity log
- `GET /api/admin/activity` → global activity log

### Lower priority (Phase 2b):
- Settings endpoints (payment provider config, email templates, branding)
- User management endpoints
- Holiday management endpoints
- Calendar data endpoint
- CSV export as JSON

### Registration in router
Add `"api/admin"` prefix to `src/routes/index.ts` lazy loader, pointing to `src/routes/admin/api.ts`.

---

## Phase 3: Tests

- Unit tests for all extracted functions in Phase 1 (test the business logic directly)
- Integration tests for Phase 2 API endpoints (mock DB, verify JSON responses)
- Maintain 100% coverage requirement

---

## What this enables

After Phase 2, users can:
- Build CLI tools for event management (`curl -X POST /api/admin/events`)
- Script bulk operations (import attendees from CSV via API)
- Build custom dashboards pulling from the API
- Wire up Zapier/n8n to admin operations
- Build a mobile admin app against the same backend

The web admin UI continues working exactly as before — it just shares business logic with the API.
