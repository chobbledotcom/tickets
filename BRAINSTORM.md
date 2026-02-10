# Feature Brainstorm

Constraints: no new personal info collection, no persistent services, no significant table changes, no external APIs, no new dependencies.

## Registration & Booking

### 1. Waitlist

When an event hits capacity, show a "join waitlist" option instead of "sold out." A small `waitlisted` flag (or separate lightweight table) tracks position. When an admin deletes an attendee, the existing webhook system fires a notification to the next waitlisted person. No personal info beyond what's already collected; no external service needed — the webhook the admin already configures handles the notification.

### 2. Self-service cancellation

Attendees already have a secret ticket token (`/t/:token`). Add a cancel button on that page. For paid events, it triggers the existing refund logic. For free events, it simply deletes the attendee and frees the spot. This reduces admin workload without collecting any new info — the token is the auth.

### 3. Duplicate registration warning

Use an HMAC blind index on the email/phone (same pattern already used for slugs and usernames) to detect when someone registers for the same event twice. Show a "you may already be registered" warning on the form. No plaintext PII stored, no new table — just a new indexed column on attendees.

### 4. Registration open time (`opens_at`)

The system already has `closes_at`. Add a symmetric `opens_at` column on events. Before that time, the form shows "Registration opens on [date]" instead of the form fields. One new encrypted column, same pattern as `closes_at`.

### 5. Short check-in codes

Generate a short alphanumeric code (e.g., `TK-8F3X`) alongside the existing token. Useful for verbal/phone check-in when scanning a QR code isn't practical — attendees can just read out the code. One new column on attendees, derived deterministically from the token so it doesn't need separate storage logic.

## Pricing & Incentives

### 6. Promo/discount codes

A small `promo_codes` table per event: `event_id`, `code_hash` (HMAC, like other blind indexes), `discount_percent` or `discount_amount`, `max_uses`, `use_count`. The ticket form gets an optional "promo code" field. Validated server-side, applied before checkout. No external API — just a price adjustment before the existing payment flow.

### 7. Tiered/early-bird pricing

Add a `price_tiers` JSON column on events (e.g., `[{"until": 50, "price": 1500}, {"until": null, "price": 2500}]`). The current attendee count determines which price tier applies. The existing `unit_price` becomes the fallback. One column, no new table.

### 8. Group discount threshold

Add an optional `group_discount_threshold` and `group_discount_percent` to events. When `quantity >= threshold`, the discount applies automatically at checkout. Two new integer columns, applied in the existing price calculation.

## Admin & Operations

### 9. Event pinning/ordering

Add a `pinned` boolean and/or `sort_order` integer column on events. Pinned events float to the top of the admin dashboard. Simple quality-of-life improvement for admins managing many events. One or two columns, no new table.

### 10. Attendee notes

Add an encrypted `notes` column on attendees. Admins can jot down internal info ("needs wheelchair access", "VIP guest") visible only in the admin detail view. One encrypted column, same encryption pattern as other fields.

### 11. Batch check-in/check-out

Add select-all / multi-select checkboxes to the attendee list, with a "check in selected" / "check out selected" action. Pure UI + a batch POST endpoint that toggles multiple attendees. No schema change at all — just a new route that calls the existing check-in toggle in a loop.

### 12. Event archiving with stats snapshot

When deactivating an event, store a summary (total registered, total checked in, total revenue) as an encrypted JSON blob in a `stats_snapshot` column on events. This preserves headline numbers even if attendees are later purged. One column.

## Public-Facing

### 13. Remaining capacity display (configurable)

Add a `show_capacity` boolean on events. When enabled, the public ticket form shows "12 spots remaining" (or "limited spots" below a threshold). One column; the count query already exists for capacity validation.

### 14. Embeddable capacity endpoint

A lightweight `GET /api/capacity/:slug` returning `{"remaining": 12, "total": 50}` (or just `{"available": true}`) as JSON. Useful for external sites to show availability without iframes. No auth needed, no PII, read-only. No schema change — uses existing queries.

### 15. Print-friendly ticket view

Add a `@media print` stylesheet and a "Print ticket" button on the `/t/:token` page. The QR code, event name, attendee name, and date render cleanly on paper. Pure CSS + minor template change. Zero schema impact.

### 16. iCal download

Add a `.ics` file download link on the ticket confirmation and ticket view pages. For standard events, use the event name + closes_at as a rough date. For daily events, use the booked date. Generated server-side from existing data — just string formatting to the iCal spec. No dependency needed, no new table, no external API.

## Data & Reporting

### 17. Attendee check-in timestamps

Replace the boolean `checked_in` ("true"/"false") with an encrypted ISO timestamp (or empty string for not checked in). Enables "average time between door open and check-in" analysis and "checked in at" display. Same column, richer data, backward-compatible (any truthy non-empty string = checked in).

### 18. Registration source tracking

Add an encrypted `source` column on attendees, auto-populated from the `Referer` header or a `?ref=` query param on the ticket URL. Lets admins see which channels drive registrations (social, email, website) without any PII. One encrypted column.

### 19. Dashboard summary stats

Add a stats row to the admin dashboard computed from existing data: total active events, total registrations this week/month, total revenue, check-in rate. No schema change — just aggregate queries over existing tables, cached in the response.
