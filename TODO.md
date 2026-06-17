# TODO: Use strict integer parsing for form and query values

## Problem

Several form/query helpers use `Number.parseInt` or `Number` directly, so values like `1abc` and `2x` can be accepted as IDs or quantities. The project already added a valibot-backed `parsePositiveIntId()` for strict decimal positive IDs, but newer shared helpers do not consistently use it.

## Fix Shape

Introduce shared strict parsers for the integer shapes the app needs, then replace lenient parsing at user-input boundaries. Do not blindly replace every `parseInt`, because some call sites parse hex, env vars, or trusted stored values.

## Implementation Steps

1. Extend `src/shared/validation/number.ts` with reusable schemas/helpers:
   - `parsePositiveIntId(value: string): number | null` for IDs, already present.
   - `parseNonNegativeInt(value: string): number | null` for quantities that allow zero.
   - `parsePositiveInt(value: string): number | null` for counts like day count or page numbers.
2. Decide whitespace behavior. Recommended: trim at the form helper layer, but schemas should validate the trimmed string as digits only.
3. Update `FormParams.getOptionalInt()` only if all callers are compatible with strict base-10 integer behavior. If not, add a new strict method and migrate call sites deliberately.
4. Update `FormParams.getNumberArray()` to drop only values that fail strict integer parsing, not values with trailing junk.
5. Update known user-input paths:
   - `src/shared/bulk-email-targets.ts` listing target parsing.
   - `src/features/admin/attendee-form-model.ts` quantity parsing.
   - Admin/public query params where IDs or quantities are currently parsed leniently.
6. Leave internal/trusted parse uses alone, such as hex parsing in IP validators, env parsing where loose defaults are intentional, and stored numeric strings where migration compatibility matters.
7. Add tests that encode the policy so future code does not regress to lenient parsing.

## Tests

Extend `test/lib/validation/number.test.ts`, `test/lib/form-data.test.ts`, and focused route/model tests.

Required cases:

1. `parsePositiveIntId("1abc")` rejects.
2. Form helpers reject or drop `1abc`, `2x`, `+1`, `1.5`, and exponent forms.
3. Valid `0` is accepted only by non-negative quantity parsers, not ID parsers.
4. Bulk email listing target rejects malformed IDs.
5. Attendee form quantity parsing rejects trailing junk.
6. Existing valid form submissions still pass.

Run:

```bash
deno task test:files test/lib/validation/number.test.ts test/lib/form-data.test.ts test/lib/attendee-form-model.test.ts test/lib/bulk-email.test.ts
deno task test:coverage
```

## Acceptance Criteria

User-controlled IDs and quantities must not accept trailing junk.

The app should use valibot-backed shared number validators instead of ad hoc parse-and-check logic at form/query boundaries.

The change must not break intentional non-decimal parsing or trusted stored-value parsing.
