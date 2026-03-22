# i18n Implementation Plan

## Architecture

**Library:** `@formatjs/intl-messageformat` (~6KB) — bundled into the edge output via esbuild (already handles npm resolution from Deno's cache).

**Locale files:** JSON per locale, namespaced by feature area. Loaded at runtime so locale can switch without rebuilding.

**Locale detection:** `Accept-Language` header → admin-configured default → `"en"`.

---

## Namespace Structure

Given the volume of strings, keys use dot-namespaced flat JSON:

```
src/locales/
  en.json
```

```json
{
  "nav.events": "Events",
  "nav.calendar": "Calendar",
  "nav.logout": "Logout",

  "guide.title": "Guide",
  "guide.getting_started.title": "Getting Started",
  "guide.getting_started.create_event_q": "How do I create an event?",
  "guide.getting_started.create_event_a": "From the <b>Events</b> page, fill in the form...",

  "fields.event.name_label": "Event Name",
  "fields.event.name_hint": "Displayed to attendees on the ticket page",
  "fields.event.name_placeholder": "Village Quiz Night",

  "errors.invalid_csrf": "Invalid or expired form. Please try again.",
  "errors.slug_taken": "Slug is already in use by another event",

  "tickets.booking_date": "Booking Date: {date}",
  "tickets.quantity": "Quantity: {count}",
  "tickets.remaining": "{count, plural, one {# ticket left} other {# tickets left}}",

  "setup.title": "Initial Setup",
  "setup.welcome": "Welcome! Please configure your ticket reservation system.",

  "email.confirmation_subject": "Your tickets for {eventNames}",

  "admin.settings.title": "Settings",
  "admin.events.active": "Active",
  "admin.events.inactive": "Inactive",

  "payment.title": "Complete Your Payment",
  "payment.cancelled_title": "Payment Cancelled",

  "wallet.event": "EVENT",
  "wallet.date": "DATE",
  "wallet.location": "LOCATION"
}
```

Namespaces: `nav`, `guide`, `fields`, `errors`, `tickets`, `setup`, `email`, `admin`, `payment`, `wallet`, `common`, `demo`, `limits`.

---

## Implementation Steps

### Step 1: Add dependency and create the i18n module

1. Add `"@formatjs/intl-messageformat": "npm:@formatjs/intl-messageformat@^10"` to `deno.json` imports
2. Create `src/lib/i18n.ts` with:
   - `addLocale(locale, messages)` — register a locale's message map
   - `t(locale, key, values?)` — translate a key with optional ICU params, falling back to English then to the key itself
   - Compiled `IntlMessageFormat` cache for performance
3. Create `src/locales/en.json` with all extracted strings (namespaced keys)
4. Add `"#i18n": "./src/lib/i18n.ts"` and `"#locales/": "./src/locales/"` to deno.json imports
5. Register English messages at app startup (import the JSON, call `addLocale("en", messages)`)

### Step 2: Thread locale through the request context

1. Add a `locale` field to the existing request context / admin session types
2. Parse `Accept-Language` header in the router to determine locale, falling back to `"en"`
3. Optionally add an admin setting for the default locale
4. Update `<html lang="en">` in `layout.tsx` to use the resolved locale

### Step 3: Extract strings — fields.ts (largest structured source)

1. Replace all `label`, `hint`, `placeholder`, and validation error strings in `fields.ts` with `t(locale, "fields.event.name_label")` calls
2. This requires threading `locale` into field-generating functions (they'll need to accept it as a parameter)
3. Validation error messages move to locale keys under `errors.*` or `fields.*.validation_*`

### Step 4: Extract strings — templates

Work through each template file, replacing hard-coded strings with `t()` calls:

1. **nav.tsx** — navigation labels (`nav.*`)
2. **layout.tsx** — lang attribute
3. **public.tsx** — public page titles and nav (`public.*`)
4. **tickets.tsx** — ticket card text (`tickets.*`)
5. **payment.tsx** — payment page text (`payment.*`)
6. **setup.tsx** — setup page and data controller agreement (`setup.*`)
7. **admin/*.tsx** — admin page titles and UI text (`admin.*`)

### Step 5: Extract strings — guide.tsx (special handling)

The guide has ~1000 lines of prose. Strategy:

- Each `<Q>` gets a key pair: `guide.{section}.{topic}_q` and `guide.{section}.{topic}_a`
- Section titles: `guide.{section}.title`
- Answer values store HTML directly in the locale JSON — rendered with `Raw` in JSX
- This keeps prose coherent for translators rather than fragmenting into tiny pieces

### Step 6: Extract strings — route error messages

1. Replace all hard-coded error/success strings in `src/routes/` with `t(locale, "errors.*")` calls
2. Locale is available from Step 2's request context

### Step 7: Extract strings — lib modules

- `demo.ts` — demo banner text (`demo.*`)
- `email.ts` — provider labels (`email.*`)
- `limits.ts` — limit entry labels (`limits.*`)
- `apple-wallet.ts` — wallet field labels (`wallet.*`)
- `google-wallet.ts` — hard-coded `"en-US"` → use resolved locale

### Step 8: Email template defaults

- Move default Liquid template subject/body strings in `email/defaults.ts` to locale keys
- User-customized email templates (stored in DB) are NOT translated — they're already user-controlled

### Step 9: Tests

1. Create `test/lib/i18n.test.ts` — test `t()` function, fallback behavior, ICU plural/select
2. Update existing tests that assert on specific string content to use locale-aware assertions or import from locale files
3. Ensure 100% coverage of the new `i18n.ts` module

### Step 10: Build verification

1. Run `deno task build:edge` — confirm `@formatjs/intl-messageformat` bundles correctly via the existing npm resolver
2. Verify bundle size stays under 10MB limit
3. Run full `deno task precommit`

---

## What's NOT in scope (initially)

- **Additional locale files** (de.json, fr.json, etc.) — only the `en.json` extraction. Adding languages is then just adding JSON files and registering them.
- **Admin UI for locale selection** — defer; Accept-Language is sufficient to start.
- **Client-side JS strings** — the admin.js / scanner.js have minimal user-facing text; can be done later.
- **Pluralization of existing messages** — only add ICU plural syntax where it already matters (e.g., ticket counts). Don't over-engineer existing simple strings.

---

## Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime vs build-time | Runtime | Locale switching without rebuild |
| Library | `@formatjs/intl-messageformat` | ICU standard, ~6KB, no framework coupling |
| Key format | Dot-namespaced flat JSON | Simple, greppable, no nested object traversal |
| Locale detection | Accept-Language header | Zero config, works immediately |
| Guide content | HTML in locale values + `Raw` | Avoids fragmenting prose into dozens of tiny keys |
| Fallback chain | requested locale → `"en"` → key name | Makes missing translations obvious during dev |
