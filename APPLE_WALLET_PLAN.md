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

### The Problem

Apple Wallet requires PNG images. We currently generate SVGs. Our existing SVG ticket is a composite document (text + QR code) designed for email — it doesn't map to Apple Wallet's image slots which are just branding images (logo, icon, strip), not full ticket renders.

### What Images We Actually Need

Apple Wallet passes render their own text layout from `pass.json` fields. The images are **branding only**:

| Image | Purpose | Size | Source |
|-------|---------|------|--------|
| `icon.png` | Lock screen / notifications | 29×29 (+ @2x, @3x) | Static platform asset |
| `logo.png` | Top-left corner of pass | ~160×50 (+ @2x, @3x) | Static platform asset OR event image |
| `strip.png` | Banner behind primary fields | 375×98 (+ @2x, @3x) | Optional — event image if available |

### Approach: Static Assets + Optional Event Image

**icon.png / logo.png**: Ship as static assets bundled with the app. These are the platform's branding — they don't change per ticket. Store as base64-encoded constants or load from the filesystem/CDN at startup.

**strip.png** (optional): If the event has an `image_url`, download it from Bunny CDN (already decrypted via `downloadImage()`), resize/crop to strip dimensions. If no event image, omit the strip — Apple Wallet handles this gracefully.

### Image Resizing for strip.png

For resizing event images to strip dimensions, options compatible with Bunny Edge (Deno-based):

1. **`@aspect-build/pngs` / `pngjs`** — Pure JS PNG encode/decode. Sufficient for basic crop/resize of an already-decoded image.
2. **`resvg-wasm`** — WASM-based SVG→PNG renderer ([deno.land/x/resvg_wasm](https://deno.land/x/resvg_wasm@0.2.0)). Useful if we wanted to render an SVG to PNG, but overkill for simple image resizing.
3. **`@resvg/resvg-js`** — Higher-level resvg bindings ([github.com/thx/resvg-js](https://github.com/thx/resvg-js)). Has both WASM and native builds.
4. **Skip resizing entirely** — Apple Wallet crops/scales images itself. We could serve the event image at a reasonable resolution and let iOS handle it.

**Recommendation**: Start with **no resizing** — just serve existing event images as strip.png and let Apple handle scaling. Add resizing later only if the visual result is poor. For icon/logo, use pre-made static PNGs at the correct sizes.

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
  - `generatePassJson(event, attendee, domain)` → `pass.json` content
  - `createManifest(files: Record<string, Uint8Array>)` → manifest with SHA-1 hashes
  - `signManifest(manifest, cert, key, wwdr)` → PKCS#7 signature bytes
  - `buildPkpass(passJson, images, cert, key, wwdr)` → complete `.pkpass` Uint8Array
- `src/lib/apple-wallet.test.ts` — Tests

Dependencies to add:
- `npm:node-forge` (signing)
- A ZIP library — `npm:fflate` (lightweight, pure JS, works everywhere) or `npm:jszip`

### Phase 2: Route + UI

- `GET /pass/:token` route → generates and returns `.pkpass` with `Content-Type: application/vnd.apple.pkpass`
- Add "Add to Apple Wallet" button to ticket view page (`/t/:tokens`)
  - Use Apple's official badge artwork
  - Only show on iOS/macOS or as a download link elsewhere
- Update `src/routes/index.ts` with the new route

### Phase 3: Admin Settings

- Add Apple Wallet configuration fields to `/admin/settings`:
  - Pass Type ID
  - Team ID
  - Signing certificate (PEM textarea or file upload)
  - Private key (PEM textarea or file upload)
- Store encrypted in settings DB (existing pattern)
- Wallet features only enabled when all four settings are configured

### Phase 4: Email Integration

- Attach `.pkpass` file to confirmation emails alongside existing SVG
- MIME type: `application/vnd.apple.pkpass`
- Filename: `ticket.pkpass`

### Phase 5: Static Assets

- Add pre-made PNG assets for icon and logo at required sizes
- Either bundle as base64 constants or store on CDN
- Consider: admin-uploadable logo/icon for per-deployment branding

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

## Open Questions

1. **Event image as strip**: Do we want to use the event's uploaded image as the strip background? It would look great but adds complexity (format conversion, sizing). Could start without it.
2. **Caching**: Should we cache generated `.pkpass` files? They're deterministic for a given ticket + settings combo. Could store on CDN.
3. **Pass updates**: Apple Wallet supports push-based pass updates via a web service. Out of scope for v1 but worth noting — would allow marking passes as "used" after check-in.
4. **Google Wallet**: Similar concept but different format (JWT-based, no signing certs needed, uses Google Pay API). Could be a follow-up.

## Dependencies Summary

| Package | Purpose | Edge Compatible |
|---------|---------|-----------------|
| `npm:node-forge` | PKCS#7 signing, SHA-1 | Yes (confirmed) |
| `npm:fflate` | ZIP archive creation | Yes (pure JS) |

No WASM or native dependencies required for the core flow. Image resizing (if needed later) would be the only part requiring WASM.
