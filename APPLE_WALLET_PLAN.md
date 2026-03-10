# Apple Wallet Pass Support

Plan for adding "Add to Apple Wallet" functionality to the ticket system.

## Overview

Generate `.pkpass` files (Apple Wallet passes) from existing ticket data so attendees can add event tickets to their Apple Wallet. The platform operator's Apple Developer signing certificate is used for all passes.

## How Apple Wallet Passes Work

A `.pkpass` file is a signed ZIP archive containing:

```
ticket.pkpass
├── pass.json          # Declarative pass content (event name, date, QR, etc.)
├── manifest.json      # SHA-1 hash of every other file in the archive
├── signature           # PKCS#7 detached signature of manifest.json
├── icon.png           # 29×29 required (lock screen, notifications)
├── icon@2x.png        # 58×58
├── logo.png           # ~160×50 (top-left branding on the pass)
├── logo@2x.png
└── strip.png          # 375×98 (optional banner behind primary fields)
```

Apple Wallet **does not accept SVGs** — all images must be PNGs. Pass layout is defined declaratively in `pass.json`, not rendered from an image.

## pass.json Structure (eventTicket type)

Maps directly to our existing `SvgTicketData` fields:

```json
{
  "formatVersion": 1,
  "passTypeIdentifier": "pass.com.example.tickets",
  "serialNumber": "<ticket_token>",
  "teamIdentifier": "<APPLE_TEAM_ID>",
  "organizationName": "Platform Name",
  "description": "Event ticket",
  "backgroundColor": "rgb(255, 255, 255)",
  "foregroundColor": "rgb(0, 0, 0)",
  "labelColor": "rgb(100, 100, 100)",
  "eventTicket": {
    "primaryFields": [
      { "key": "event", "label": "EVENT", "value": "Concert Name" }
    ],
    "secondaryFields": [
      {
        "key": "date", "label": "DATE",
        "value": "2026-03-15T19:00+00:00",
        "dateStyle": "PKDateStyleMedium",
        "timeStyle": "PKDateStyleShort"
      },
      { "key": "location", "label": "LOCATION", "value": "Venue Name" }
    ],
    "auxiliaryFields": [
      { "key": "qty", "label": "QTY", "value": "2" },
      { "key": "price", "label": "PRICE", "value": 25.00, "currencyCode": "EUR" }
    ],
    "backFields": [
      { "key": "booking-date", "label": "Booking Date", "value": "..." },
      { "key": "terms", "label": "Terms", "value": "..." }
    ]
  },
  "barcodes": [{
    "format": "PKBarcodeFormatQR",
    "message": "https://domain.com/checkin/<token>",
    "messageEncoding": "iso-8859-1"
  }],
  "relevantDate": "2026-03-15T19:00+00:00"
}
```

## PNG Image Strategy

**v1: No images.** Apple Wallet passes work without images — the pass renders text fields from `pass.json` and the QR code. Images (icon, logo, strip) are branding-only and optional for functionality. We skip them entirely in v1 to keep the implementation simple. Images can be added later as static assets or admin-uploadable files.

## Signing

### Prerequisites (One-Time Setup)

1. Apple Developer account ($99/year)
2. Create a Pass Type ID in the Apple Developer portal (e.g., `pass.com.yourdomain.tickets`)
3. Generate a signing certificate for that Pass Type ID
4. Export as `.p12`, convert to PEM format
5. Download the WWDR (Apple Worldwide Developer Relations) intermediate certificate

### Signing Process

1. Create `manifest.json` — SHA-1 hash of every file in the pass package
2. Create PKCS#7 detached signature of `manifest.json` using:
   - The Pass Type ID signing certificate + private key
   - The WWDR intermediate certificate
3. ZIP everything into a `.pkpass` file

### Library: `node-forge`

Already confirmed to work on edge. Use for:
- Parsing PEM certificates
- Creating PKCS#7 (CMS) signatures
- SHA-1 hashing for manifest

No additional dependencies needed beyond `npm:node-forge`.

### Certificate Storage

Store in admin settings (same pattern as Stripe keys):
- `apple_pass_type_id` — e.g., `pass.com.yourdomain.tickets`
- `apple_team_id` — Apple Developer Team ID
- `apple_signing_cert` — PEM-encoded signing certificate
- `apple_signing_key` — PEM-encoded private key

All stored encrypted in the database via the existing settings system.

## Implementation Plan

### Phase 1: Core `.pkpass` Generation

New files:
- `src/lib/apple-wallet.ts` — Core pass generation logic
  - `generatePassJson(data)` → `pass.json` content
  - `createManifest(files: Record<string, Uint8Array>)` → manifest with SHA-1 hashes
  - `signManifest(manifest, cert, key, wwdr)` → PKCS#7 signature bytes
  - `buildPkpass(data, cert, key, wwdr)` → complete `.pkpass` Uint8Array (no images in v1)
- `test/lib/apple-wallet.test.ts` — Tests

Dependencies to add:
- `npm:node-forge` (signing)
- `npm:fflate` (lightweight, pure JS ZIP creation)

### Phase 2: Route + UI

- `GET /wallet/:token` route → generates `.pkpass` with `Content-Type: application/vnd.apple.pkpass`
- CDN caching: set `Cache-Control` headers so the CDN caches generated passes
- Add "Add to Apple Wallet" button/link to ticket view page (`/t/:tokens`)
- Update `src/routes/index.ts` with the new route (lazy-loaded)

### Phase 3: Admin Settings

- Add Apple Wallet configuration fields to `/admin/settings`:
  - Pass Type ID
  - Team ID
  - Signing certificate (PEM textarea)
  - Private key (PEM textarea)
  - WWDR certificate (PEM textarea)
- Store encrypted in settings DB (existing pattern)
- Wallet button only shown on ticket view when all settings are configured

### Out of Scope (v1)

- **Images**: No icon, logo, or strip images. Pass renders text + QR only.
- **Pass updates**: No push-based pass updates after check-in.
- **Google Wallet**: Separate follow-up.
- **Email attachment**: Can be added later.

## Data Flow

```
Attendee views /t/<token>
  → clicks "Add to Apple Wallet"
  → GET /pass/<token>
  → lookup attendee by token (existing flow)
  → load Apple Wallet settings from DB
  → generatePassJson() from event + attendee data
  → load static icon/logo PNGs
  → optionally load event image for strip.png
  → createManifest() with SHA-1 hashes
  → signManifest() with node-forge PKCS#7
  → ZIP everything with fflate
  → return .pkpass with correct Content-Type
```

## Decisions

1. **No images in v1** — skip icon/logo/strip PNGs entirely
2. **CDN caching** — set long `Cache-Control` on `/wallet/:token` responses; site already runs through CDN
3. **Pass updates** — out of scope for v1
4. **Google Wallet** — separate follow-up, handled later

## Dependencies Summary

| Package | Purpose | Edge Compatible |
|---------|---------|-----------------|
| `npm:node-forge` | PKCS#7 signing, SHA-1 | Yes (confirmed) |
| `npm:fflate` | ZIP archive creation | Yes (pure JS) |

No WASM or native dependencies required.
