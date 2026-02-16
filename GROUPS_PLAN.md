# Add Groups to Events

## Context

Groups let admins bundle related events under a single URL. Attendees visiting `/ticket/group-slug` see all active events in the group on one multi-ticket page and can book multiple at once. Groups can optionally override the global terms and conditions. This feature adds a new `groups` table, admin CRUD pages, a `group_id` column on events, and public routing for group slugs.

---

## 1. Types — `src/lib/types.ts`

- Add `Group` interface: `id`, `slug`, `slug_index`, `name`, `terms_and_conditions`
- Add `group_id: number` to `Event` interface

## 2. Groups DB module — `src/lib/db/groups.ts` *(new file)*

Follow `src/lib/db/holidays.ts` pattern exactly:

- `GroupInput` type: `slug`, `slugIndex`, `name`, `termsAndConditions`
- `computeGroupSlugIndex(slug)` → `hmacHash(slug)` (same HMAC space as events)
- `groupsTable = defineTable<Group, GroupInput>()` with schema:
  - `id: col.generated<number>()`
  - `slug: col.encrypted<string>(encrypt, decrypt)`
  - `slug_index: col.simple<string>()`
  - `name: col.encrypted<string>(encrypt, decrypt)`
  - `terms_and_conditions`: `{ default: () => "", write: encrypt, read: decrypt }`
- `queryGroups(stmt)` — decrypt helper (same as holidays pattern)
- `getAllGroups()` — SELECT * ORDER BY id ASC
- `getGroupBySlugIndex(slugIndex)` — single group lookup by slug_index
- `isGroupSlugTaken(slug, excludeGroupId?)` — check BOTH `events` AND `groups` tables
- `getActiveEventsByGroupId(groupId)` — fetch active events (active=1) with attendee counts, using `eventsTable.fromDb()` for decryption
- `resetGroupEvents(groupId)` — `UPDATE events SET group_id = 0 WHERE group_id = ?`

## 3. Events DB — `src/lib/db/events.ts`

- Add `groupId?: number` to `EventInput`
- Add `group_id: col.withDefault(() => 0)` to `eventsTable.schema`
- Update `isSlugTaken(slug, excludeEventId?)` to also check `groups` table for cross-table uniqueness

## 4. Migrations — `src/lib/db/migrations/index.ts`

- Update `LATEST_UPDATE` string
- Add `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, slug_index TEXT NOT NULL, name TEXT NOT NULL, terms_and_conditions TEXT NOT NULL DEFAULT '')`
- Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_slug_index ON groups(slug_index)`
- Add `ALTER TABLE events ADD COLUMN group_id INTEGER NOT NULL DEFAULT 0`
- No backfill needed on groups table (it's new, no existing rows)
- Backfill `group_id` on existing events: already handled by `DEFAULT 0` in the ALTER TABLE, but existing rows with NULL need explicit `UPDATE events SET group_id = 0 WHERE group_id IS NULL` (SQLite quirk: ALTER ADD COLUMN with NOT NULL DEFAULT applies the default to existing rows, so this is a safety net)
- Add `"groups"` to `ALL_TABLES` array (before `"holidays"`)

## 5. Form fields — `src/templates/fields.ts`

- Add `GroupFormValues` type: `name: string`, `slug: string`, `terms_and_conditions: string`
- Add `groupFields: Field[]` array:
  - name (text, required)
  - slug (text, required, validate with `validateSlug(normalizeSlug(value))`)
  - terms_and_conditions (textarea, optional, hint about overriding global T&Cs)
- Import `normalizeSlug`, `validateSlug` from `#lib/slug.ts` (already imported)

## 6. Admin group templates — `src/templates/admin/groups.tsx` *(new file)*

Follow `src/templates/admin/holidays.tsx` exactly:

- `adminGroupsPage(groups, session, error?)` — list page with table (Name, Slug, Actions: Edit/Delete)
- `groupToFieldValues(group?)` — form value conversion
- `adminGroupNewPage(session, error?)` — create form
- `adminGroupEditPage(group, session, error?)` — edit form
- `adminGroupDeletePage(group, session, error?)` — delete confirmation; note: "Events in this group will not be deleted — they will be moved out of the group."

## 7. Admin nav — `src/templates/admin/nav.tsx`

Add owner-only link before Holidays:
```tsx
{session.adminLevel === "owner" && <li><a href="/admin/groups">Groups</a></li>}
```

## 8. Admin group routes — `src/routes/admin/groups.ts` *(new file)*

Follow `src/routes/admin/holidays.ts` exactly:

- `extractGroupInput(values)` → `GroupInput` (normalize slug, compute slugIndex)
- `groupsResource = defineResource({ table: groupsTable, fields: groupFields, toInput, nameField: "name", validate, onDelete })`
  - `validate`: call `isGroupSlugTaken(input.slug, id?)`, return error if taken
  - `onDelete`: call `resetGroupEvents(id)` then `groupsTable.deleteById(id)`
- Routes: `GET /admin/groups`, `GET /admin/group/new`, `POST /admin/group`, `GET /admin/group/:id/edit`, `POST /admin/group/:id/edit`, `GET /admin/group/:id/delete`, `POST /admin/group/:id/delete`
- All routes use `requireOwnerOr` / `withOwnerAuthForm`
- Export `groupsRoutes`

## 9. Register routes — `src/routes/admin/index.ts`

- Import `groupsRoutes` from `"#routes/admin/groups.ts"`
- Spread `...groupsRoutes` into `adminRoutes`

## 10. Group select on event forms

### Dashboard — `src/routes/admin/dashboard.ts`
- Import `getAllGroups` from `"#lib/db/groups.ts"`
- Fetch groups in `handleAdminGet`, pass to `adminDashboardPage`

### Dashboard template — `src/templates/admin/dashboard.tsx`
- Accept `groups: Group[]` parameter (imported from types)
- If `groups.length > 0`, render a `<select name="group_id">` with `<option value="0">No Group</option>` plus each group as an option, between the existing fields and the submit button

### Event routes — `src/routes/admin/events.ts`
- Import `getAllGroups`
- In `handleAdminEventEditGet` and `handleAdminEventDuplicateGet`: fetch groups, pass to templates
- In `extractCommonFields`: add `groupId: Number(values.group_id) || 0`
- Note: `EventFormValues` in fields.ts needs `group_id: string` added
- In `handleAdminEventEditPost`: pass groups to `adminEventEditPage` on error

### Event templates — `src/templates/admin/events.tsx`
- Accept `groups: Group[]` in `adminEventEditPage`, `adminDuplicateEventPage`
- Render group select if groups exist, pre-selecting the event's current `group_id`
- In `eventToFieldValues`: add `group_id: event.group_id`

## 11. Group slug routing — `src/routes/public.ts`

Modify the single-slug path in `routeTicket`:

**GET**: Instead of directly calling `handleTicketGet`, first try event lookup. If event not found, try group lookup. The cleanest way: refactor the single-slug GET path to:
1. Import `computeGroupSlugIndex`, `getGroupBySlugIndex`, `getActiveEventsByGroupId` from `"#lib/db/groups.ts"`
2. Try `withActiveEventBySlug` for the event
3. If the event lookup returns 404, attempt group lookup: compute slug index, query group, fetch active events, render as multi-ticket page
4. For group T&Cs: use `group.terms_and_conditions || globalTerms` — group T&Cs override global when set
5. Form action on group page: `/ticket/group-slug` (keeps the URL stable)

**POST**: Same fallback pattern:
1. Try event lookup first (existing `processTicketReservation`)
2. If event not found, try group lookup
3. If group found, assemble active events and delegate to multi-ticket POST processing logic

Add new helpers:
- `handleGroupTicketGet(slug, request)` — group GET handler
- `handleGroupTicketPost(slug, request)` — group POST handler (reuses multi-ticket processing)

## 12. Guide page — `src/templates/admin/guide.tsx`

Add a Q&A in the "Events" section (after the multi-booking question):

```tsx
<Q q="What are groups?">
  <p>
    Groups let you bundle related events under a single URL. Create a
    group from the <strong>Groups</strong> page, then assign events to
    it using the group dropdown on the event form. Share{" "}
    <code>/ticket/your-group-slug</code> and attendees see all active
    events in the group on one page. If you add terms and conditions to
    a group, they replace the global T&amp;Cs for that page.
  </p>
</Q>
```

## 13. Test utilities — `src/test-utils/index.ts`

- Import `Group` from types, `GroupInput` from groups DB
- Add `testGroup(overrides?)` factory (like `testHoliday`)
- Add `createTestGroup(overrides?)` — authenticated form request to `POST /admin/group` (like `createTestHoliday`)
- Add `updateTestGroup(groupId, updates)` (like `updateTestHoliday`)
- Add `deleteTestGroup(groupId)` (like `deleteTestHoliday`)
- Update `testEvent` and `testEventWithCount` defaults to include `group_id: 0`
- Update `createTestEvent` form data to include `group_id: "0"` (or from overrides)
- Update `updateTestEvent` form data to include `group_id`
- Export `GroupInput`

## 14. Tests

### `test/lib/server-groups.test.ts` *(new file)*

Follow `test/lib/server-holidays.test.ts` pattern:
- List groups (empty, with data)
- Create group (valid, duplicate slug, slug collision with event, invalid slug)
- Edit group (valid, slug collision, name change)
- Delete group (name confirmation, events reset to group_id=0, events NOT deleted)
- Owner-only access checks (manager gets redirect/403)

### Update `test/lib/server-events.test.ts`
- Event create with group_id
- Event edit with group_id
- Event slug validation checks groups table too

### Update `test/lib/server-public.test.ts`
- `GET /ticket/group-slug` renders multi-ticket page with group's active events
- `GET /ticket/group-slug` returns 404 when group has no active events
- `POST /ticket/group-slug` processes registration for group events
- Group T&Cs override global T&Cs
- Group T&Cs fall back to global when group T&Cs are empty

### Update `test/lib/db.test.ts`
- `groupsTable` CRUD
- `isGroupSlugTaken` cross-table check
- `getActiveEventsByGroupId`
- `resetGroupEvents`

### Update existing tests
- Any test referencing `testEvent()` or `testEventWithCount()` should still work since `group_id: 0` is added as a default

---

## Files Summary

**New files (4):**
- `src/lib/db/groups.ts`
- `src/templates/admin/groups.tsx`
- `src/routes/admin/groups.ts`
- `test/lib/server-groups.test.ts`

**Modified files (~14):**
- `src/lib/types.ts`
- `src/lib/db/events.ts`
- `src/lib/db/migrations/index.ts`
- `src/templates/fields.ts`
- `src/templates/admin/nav.tsx`
- `src/templates/admin/dashboard.tsx`
- `src/templates/admin/events.tsx`
- `src/templates/admin/guide.tsx`
- `src/routes/admin/index.ts`
- `src/routes/admin/dashboard.ts`
- `src/routes/admin/events.ts`
- `src/routes/public.ts`
- `src/test-utils/index.ts`
- `test/lib/server-events.test.ts`
- `test/lib/server-public.test.ts`
- `test/lib/db.test.ts`

---

## Key Design Decisions

1. **Shared HMAC space**: Groups and events use the same `hmacHash()` for slug indexes. Both `isSlugTaken` (events) and `isGroupSlugTaken` (groups) check both tables, preventing slug collisions.

2. **Event slug priority**: In `routeTicket`, event lookup happens first. Group lookup is the fallback. If somehow both match (prevented by shared uniqueness), the event wins.

3. **Group page form action**: Uses `/ticket/group-slug` (not joined event slugs). This keeps URLs stable even as events are added/removed from the group.

4. **T&Cs override**: Group T&Cs replace global T&Cs when non-empty. When empty, global T&Cs apply as fallback.

5. **Deletion is soft for events**: Deleting a group resets `group_id` to 0 on its events (no cascade delete).

6. **Conditional group select**: The group_id `<select>` only renders when groups exist, keeping the UI clean when groups aren't in use.

---

## Verification

1. `deno task precommit` — typecheck, lint, tests pass with 100% coverage
2. Manual: create a group, assign events, visit `/ticket/group-slug`, book tickets
3. Manual: delete a group, verify events still exist with group_id=0
4. Manual: set group T&Cs, verify they override global T&Cs on the group page
5. Manual: verify event slug and group slug collision is rejected
