# TODO: Delete modifier usage rows when deleting attendees

## Problem

`deleteAttendee()` purges processed payments, attendee answers, listing links, and the attendee row, but it does not delete `modifier_usages`. Since modifier stock and aggregate columns are now maintained from `modifier_usages`, deleted attendees can leave stock permanently consumed and modifier totals inflated.

## Fix Shape

Include `modifier_usages` in the attendee purge batch before deleting the attendee. The aggregate triggers on `modifier_usages` should decrement `modifiers.total_uses`, `usage_count`, and `total_revenue` automatically.

## Implementation Steps

1. Update `src/shared/db/attendees/delete.ts`.
2. Add a batch statement before deleting the attendee:
   - `DELETE FROM modifier_usages WHERE attendee_id = ?`
3. Keep the statement before `DELETE FROM attendees WHERE id = ?`.
4. Confirm that deleting modifier usages fires aggregate triggers correctly.
5. Confirm that rollback paths that call `deleteAttendee()` after failed modifier stock consumption remain safe. `consumeModifierStock()` already deletes partial usage rows for the attendee before returning false, so the extra purge should be idempotent.

## Tests

Add tests in `test/lib/db/attendees/delete-attendee.test.ts` or `test/lib/db/modifier-aggregates.test.ts`.

Required cases:

1. Create an attendee, create a modifier, insert/consume a usage row, delete the attendee, and assert `modifier_usages` has no row for that attendee.
2. Assert `modifierUsedQuantities([modifierId])` returns zero after attendee deletion.
3. Assert `modifiers.total_uses`, `usage_count`, and `total_revenue` are decremented by the trigger after deletion.
4. Deleting an attendee with no modifier usage still succeeds.

Run:

```bash
deno task test:files test/lib/db/attendees/delete-attendee.test.ts test/lib/db/modifier-aggregates.test.ts test/lib/db/modifier-usage.test.ts
deno task test:coverage
```

## Acceptance Criteria

No modifier stock or aggregate data remains consumed by a deleted attendee.

The fix must not require foreign-key cascade support.

The purge must remain idempotent.
