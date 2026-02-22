# Plan: Phone Prefix Setting + Tel Links

## Overview

Add a configurable phone prefix setting (default: `44`) used in two places:
1. **Square checkout** — normalize the phone number (strip non-numeric chars, replace leading `0` with `+{prefix}`) before sending to Square's `buyerPhoneNumber` field
2. **Attendee table** — render phone numbers as clickable `tel:` links using the same normalization

---

## 1. Create phone normalization utility

**New file: `src/lib/phone.ts`**

```typescript
/** Strip non-numeric characters from a phone number, then prefix if it starts with 0 */
export const normalizePhone = (phone: string, prefix: string): string => {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("0") ? "+" + prefix + digits.slice(1) : "+" + digits;
};
```

- Input: raw phone string (e.g. `"07700 900000"`) + prefix (e.g. `"44"`)
- Output: `+` prefixed, digits-only, country-prefixed if needed (e.g. `"+447700900000"`)

---

## 2. Add `PHONE_PREFIX` setting to settings module

**File: `src/lib/db/settings.ts`**

- Add `PHONE_PREFIX: "phone_prefix"` to `CONFIG_KEYS`
- Add `getPhonePrefixFromDb()` — returns the setting value or `"44"` as default
- Add `updatePhonePrefix(prefix: string)` — validates it's digits-only, saves to DB
- Add both to `settingsApi` object

---

## 3. Admin settings UI

### Template: `src/templates/admin/settings.tsx`

- Add `phonePrefix?: string` parameter to `adminSettingsPage()`
- Add a form section immediately after the currency code setting:
  - Label: "Phone Prefix"
  - Description: Country calling code used when normalizing phone numbers that start with 0 (e.g. 44 for UK, 1 for US)
  - Input: `type="number"` with `step="1"` (integer only, no decimals), defaulting to `"44"`, `name="phone_prefix"`
  - Action: `/admin/settings/phone-prefix`

### Route: `src/routes/admin/settings.ts`

- Import `getPhonePrefixFromDb` and `updatePhonePrefix`
- Add `phonePrefix` to `getSettingsPageState()` and pass through `renderSettingsPage()`
- Add `processPhonePrefixForm` handler:
  - Extract `phone_prefix` from form
  - Validate: non-empty, digits only
  - Call `updatePhonePrefix()`
  - Log activity, redirect with success
- Register route: `POST /admin/settings/phone-prefix`

---

## 4. Normalize phone for Square checkout

**File: `src/lib/square.ts`**

In `squareApi.createPaymentLink` and `squareApi.createMultiPaymentLink`:

- Import `normalizePhone` from `#lib/phone.ts` and `getPhonePrefixFromDb` from settings
- Before passing phone to `createPaymentLinkImpl`, normalize it:
  ```typescript
  const prefix = await getPhonePrefixFromDb();
  const normalizedPhone = intent.phone ? normalizePhone(intent.phone, prefix) : undefined;
  ```
- Pass `normalizedPhone` as `phone` to `createPaymentLinkImpl` (already includes `+` prefix from `normalizePhone`)
- The metadata phone (`buildSingleIntentMetadata` / `buildMultiIntentMetadata`) stays as the raw user input — it's used for attendee record creation, not the payment form

---

## 5. Clickable tel links in attendee table

**File: `src/templates/attendee-table.tsx`**

- Add `phonePrefix?: string` to `AttendeeTableOptions`
- Import `normalizePhone` from `#lib/phone.ts`
- Change the phone cell rendering from:
  ```tsx
  {vis.showPhone && <td>{a.phone || ""}</td>}
  ```
  to:
  ```tsx
  {vis.showPhone && <td>{a.phone ? <a href={`tel:${normalizePhone(a.phone, opts.phonePrefix || "44")}`}>{a.phone}</a> : ""}</td>}
  ```
- The display text remains the original phone number; the `href` uses the normalized version (already includes `+` from `normalizePhone`)

### Update all 3 call sites to pass `phonePrefix`:

1. **`src/templates/admin/events.tsx`** — the event detail page already receives data from the route handler; add `phonePrefix` to the template props and pass through
2. **`src/templates/admin/calendar.tsx`** — same pattern
3. **`src/templates/checkin.tsx`** — same pattern

Each of these templates is called from a route handler that can fetch the prefix via `getPhonePrefixFromDb()`.

---

## 6. Tests

All new/changed code needs 100% test coverage:

- **`test/lib/phone.test.ts`** — unit tests for `normalizePhone`:
  - Strips spaces, hyphens, parentheses, plus signs
  - Replaces leading 0 with prefix
  - Leaves numbers not starting with 0 unchanged
  - Handles empty/whitespace input
  - Works with different prefix values

- **`test/lib/settings.test.ts`** — add tests for:
  - `getPhonePrefixFromDb()` returns "44" by default
  - `getPhonePrefixFromDb()` returns saved value
  - `updatePhonePrefix()` saves to DB

- **`test/lib/attendee-table.test.ts`** — add tests for:
  - Phone numbers render as `<a href="tel:+...">` links
  - The href uses the normalized phone number
  - `phonePrefix` option is respected

- **`test/routes/admin/settings.test.ts`** — add tests for:
  - POST `/admin/settings/phone-prefix` saves valid prefix
  - POST `/admin/settings/phone-prefix` rejects non-digit input
  - GET `/admin/settings` includes phone prefix in rendered page

- **`test/lib/square.test.ts`** — add/update tests for:
  - `createPaymentLink` sends normalized phone to Square API
  - `createMultiPaymentLink` sends normalized phone to Square API

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/lib/phone.ts` | **New** — `normalizePhone()` utility |
| `src/lib/db/settings.ts` | Add `PHONE_PREFIX` key, getter, setter |
| `src/templates/admin/settings.tsx` | Add phone prefix form, new parameter |
| `src/routes/admin/settings.ts` | Add phone prefix route handler |
| `src/lib/square.ts` | Normalize phone before sending to Square |
| `src/templates/attendee-table.tsx` | Render phone as `tel:` link |
| `src/templates/admin/events.tsx` | Pass `phonePrefix` to AttendeeTable |
| `src/templates/admin/calendar.tsx` | Pass `phonePrefix` to AttendeeTable |
| `src/templates/checkin.tsx` | Pass `phonePrefix` to AttendeeTable |
| `test/lib/phone.test.ts` | **New** — normalizePhone tests |
| `test/lib/settings.test.ts` | Phone prefix getter/setter tests |
| `test/lib/attendee-table.test.ts` | Tel link tests |
| `test/routes/admin/settings.test.ts` | Phone prefix route tests |
| `test/lib/square.test.ts` | Normalized phone tests |
