# Mobilizon Integration: Research & Implementation Plan

## What is Mobilizon?

[Mobilizon](https://mobilizon.org/) is a decentralized, open-source event management platform built by Framasoft in Elixir. It federates via ActivityPub, so events published on one instance are discoverable across the Fediverse. Key features:

- **Federation**: Instances connect via ActivityPub (server-to-server). Events, groups, and comments federate across instances.
- **GraphQL API**: Full CRUD for events, groups, participants — authenticated via JWT. Every instance exposes `/api` and a playground at `/graphiql`.
- **Standard feeds**: Each group exposes RSS/Atom and ICS/WebCal feeds for its events.
- **Event imports**: A built-in [importer service](https://import.mobilizon.fr/) can crawl ICS feeds from external sources and auto-create events in Mobilizon.
- **External join mode**: Events support `joinMode: "external"` — designed for linking to an external registration system.

## How the Two Systems Compare

| Concern | Chobble Tickets | Mobilizon |
|---|---|---|
| **Purpose** | Ticketed registration with payments, capacity, check-in | Social/federated event discovery, RSVPs, group discussion |
| **Events** | Name, slug, capacity, price, fields, dates, images | Title, description, dates, location (geo), tags, categories, visibility |
| **Registration** | Form submission → payment → encrypted attendee record | RSVP / "Join" (free/restricted/external/invite) |
| **Payments** | Stripe, Square (pluggable) | None built-in |
| **Federation** | None | ActivityPub (server-to-server) |
| **Feeds** | None currently | RSS/Atom, ICS/WebCal per group |
| **API** | Internal HTTP routes only | Full GraphQL API |

**Key insight**: Mobilizon handles *event discovery and social federation*. Chobble Tickets handles *ticketed registration, payments, capacity management, and check-in*. They are complementary, not competing.

## Integration Strategies Evaluated

### Strategy 1: Tickets Publishes ICS/RSS Feeds → Mobilizon Imports (Recommended)

Events are created in Tickets. Tickets publishes ICS and RSS feeds. A Mobilizon admin points the Mobilizon importer at the ICS feed → events auto-appear in Mobilizon with `joinMode: "external"` links back to Tickets for registration.

**Pros**: Minimal code (two read-only endpoints), no external dependencies, works with any Mobilizon instance or ICS/RSS consumer, preserves security model (no PII leaves the system).

### Strategy 2: Tickets Pulls Events from Mobilizon (Sync Inbound)

An admin configures a Mobilizon instance URL + group. Tickets fetches events via GraphQL or ICS and auto-creates local events.

**Pros**: Events managed centrally in Mobilizon. **Cons**: Requires outbound network calls (may not work on Bunny Edge), field mapping complexity, events still need manual price configuration.

### Strategy 3: Full ActivityPub Federation

Tickets implements ActivityPub server-to-server protocol, appearing as a Fediverse actor that publishes events.

**Pros**: Full federation. **Cons**: Very large scope (WebFinger, HTTP Signatures, inbox/outbox, JSON-LD), ongoing maintenance, overkill given ICS/RSS achieves 90% of the value.

## Chosen Approach: Strategy 1

Implement ICS and RSS feeds from Tickets, gated behind the existing `show_public_site` setting. Document how to connect them to Mobilizon.

### Implementation Steps

#### 1. Add `getBoolSetting`/`setBoolSetting` helpers

Clean up the `show_public_site` (and similar) settings that use `value === "true"` string comparison. Add centralized boolean setting helpers to `src/lib/db/settings.ts`.

#### 2. Create feed route handlers (`src/routes/feeds.ts`)

Two endpoints:
- `GET /feeds/events.ics` — all active events as iCalendar feed (`text/calendar`)
- `GET /feeds/events.rss` — all active events as RSS feed (`application/rss+xml`)

Both gated behind `show_public_site`. Each event's URL points to its Tickets registration page (`/ticket/:slug`).

Reuses: `getAllEvents()`, `sortEvents()`, `getActiveHolidays()`, `getAllowedDomain()`, `getWebsiteTitleFromDb()`, `isRegistrationClosed()`.

#### 3. Register routes in `src/routes/index.ts`

Add lazy-loaded `feeds` prefix to the dispatch table.

#### 4. Add feed discovery `<link>` tags to public events page

RSS auto-discovery in `<head>` so browsers and feed readers find the feeds.

#### 5. Add Mobilizon integration section to admin guide

Document feed URLs and how to connect them to Mobilizon via its importer.

#### 6. Tests (`test/lib/server-feeds.test.ts`)

Full coverage of both feed endpoints including content type, event inclusion/exclusion, public site guard, special character escaping.

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/db/settings.ts` | Modify | Add `getBoolSetting`/`setBoolSetting` helpers |
| `src/routes/feeds.ts` | Create | ICS and RSS feed route handlers |
| `src/routes/index.ts` | Modify | Register feed routes in prefix dispatch |
| `src/templates/public.tsx` | Modify | Add `<link>` feed discovery tags |
| `src/routes/admin/guide.ts` | Modify | Add Mobilizon integration docs |
| `test/lib/server-feeds.test.ts` | Create | Tests for feed endpoints |
