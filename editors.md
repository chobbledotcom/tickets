# Planning: the "Editor" user class

## Goal

Add a fourth user class, **Editor**, alongside the existing `owner`, `manager`,
and `agent` roles. An Editor is a content-only collaborator:

- **Can** create and edit listings and groups.
- **Can** edit the content of the public-facing site (homepage, contact, order
  intro — the pages under Settings → Site).
- **Cannot** view or edit attendees (they have no private key, so attendee PII
  is undecryptable for them, and they are route-gated out anyway).
- **Cannot** read any ledger detail.
- **Cannot** change any settings other than the public-site content.
- **Has no API access** of any kind.
- **Does not appear** the staff navigation — their nav shows only the pages they
  can actually reach.

This mirrors the design intent already established for the `agent` role: a
restricted login that is *excluded by default* from every staff page and
*explicitly opted in* to the handful of routes it needs.

## Capability matrix

| Capability | owner | manager | agent | **editor** |
| --- | :-: | :-: | :-: | :-: |
| View / edit attendees (PII) | ✓ | ✓ | partial¹ | **✗** |
| Create / edit listings | ✓ | ✓ | ✗ | **✓** |
| Create / edit groups | ✓ | ✓ | ✗ | **✓** |
| Edit public-site content (Settings → Site) | ✓ | ✗² | ✗ | **✓** |
| View / edit general settings | ✓ | ✗ | ✗ | **✗** |
| Read ledger | ✓ | ✗ | ✗ | **✗** |
| Manage users / sessions | ✓ | ✗ | ✗ | **✗** |
| API access (API keys / Bearer) | ✓ | ✓³ | ✗ | **✗** |
| Holds a DATA_KEY / can derive private key | ✓ | ✓ | ✓ | **✗** |
| Delivery run sheet (`/admin/deliveries`) | ✓ | ✓ | ✓ | **✗** |

¹ Agents decrypt a *narrowed* logistics view of attendees on their run sheet.
² Site editing is currently **owner-only**; this plan adds `editor` to that gate
without changing the manager position (see [Open questions](#open-questions)).
³ Via `ADMIN_API` routes; managers inherit staff API access.

## Key architectural insight — Editors can genuinely lack the private key

The system uses **two independent keys**, and they map cleanly onto this
requirement:

- **`DB_ENCRYPTION_KEY`** (environment secret, available to all server code)
  encrypts general DB content: listing fields (`src/shared/db/listings.ts`
  — `description`, `location`, `image_url`, `thank_you_url`, …), group fields
  (`src/shared/db/groups.ts`), settings, and the public-site content edited via
  `src/features/admin/site.ts`. **No per-user key is needed to read or write any
  of this.**

- **The owner key pair** (`settings.wrappedPrivateKey`) decrypts attendee PII.
  Its private half is derived per-session from the user's **DATA_KEY**:
  `getPrivateKeyFromSession(session.token, session.wrappedDataKey,
  settings.wrappedPrivateKey)` in `src/shared/session-private-key.ts:42-57`.

Crucially, the user's `wrapped_data_key` exists *only* to unwrap the private key
(`src/shared/crypto/keys.ts` — `getPrivateKeyFromSession`). It is **not** used to
read listings, groups, settings, or site content. And the derivation has exactly
two gates and **no role check** (`session-private-key.ts:45-46`):

```ts
if (!session.wrappedDataKey) return null;       // gate 1
if (!settings.wrappedPrivateKey) return null;   // gate 2
```

Therefore: **an Editor created without a `wrapped_data_key` literally cannot
derive the private key** (gate 1 fails), yet can still do everything their role
requires (all DB-key-encrypted content). This is the cleanest possible
implementation of "won't have privateKey" — it is enforced by the absence of key
material, not merely by a route check. The route gating becomes defense in
depth.

> Contrast with `agent`: agents *do* get a `wrapped_data_key` because their run
> sheet must decrypt attendee logistics (`deliveries.ts:157`
> `requireRequestPrivateKey()`). Editors are the first activated role that holds
> **no** DATA_KEY — the schema already allows it (`wrapped_data_key` is
> nullable, used today for invited-but-not-yet-activated users).

## Design decisions

1. **`editor` is NOT a member of `STAFF_ADMIN_LEVELS`.** That constant
   (`src/shared/types.ts:423`) is the default-allow set for any gate that names
   no explicit role (`sessionRoleAllowed`, `auth.ts:241-249`). Keeping `editor`
   out means every existing staff page rejects editors *by default*, and we only
   widen the specific routes the role needs — same fail-closed posture that makes
   `agent` safe.

2. **Editors are activated with `wrapped_data_key = NULL`.** No DATA_KEY handoff
   is wrapped into their invite, and activation sets a password without one. This
   is the mechanism that removes the private key.

3. **Editors get a real (filtered) navigation**, not the `agent` treatment of a
   bare header. They legitimately move between Listings, Groups, and the Site
   editor, so the nav should list exactly those.

## Implementation plan

Ordered hardest-first (per repo convention). The key-handling/activation path is
the riskiest and is tackled first.

### 1. Authentication & key material (the hard part)

**`src/shared/db/users.ts`**

- Add a creation/activation path for a **no-DATA_KEY** invited user:
  - Invite with `invite_wrapped_data_key = NULL` (no handoff). `createInvitedUser`
    already accepts a null handoff (`users.ts:238-254`).
  - `acceptInvite` (`users.ts:343-365`) currently *requires* a handoff (it
    unwraps `inviteWrappedDataKey` and is guarded on `IS NOT NULL`). Add a
    sibling activation function for editors that sets `password_hash`, leaves
    `wrapped_data_key = NULL`, and clears the invite — guarded so it is
    single-use and cannot be used to wipe a normal user's key.
- **Login path**: confirm login tolerates a user whose `wrapped_data_key` is
  `NULL` — it must create a session with `wrapped_data_key = NULL` rather than
  attempting `unwrapKeyWithToken`/`migrateUserToV2Kek` (`users.ts:373-394`). The
  resulting session simply yields `getRequestPrivateKey() → null`. This is the
  single most important branch to get right and test.

**`src/shared/session-private-key.ts`** — no change needed; gate 1 already
returns `null` for a session with no `wrappedDataKey`. Add tests asserting an
editor session derives `null`.

### 2. Types & constants

**`src/shared/types.ts`**

- `AdminLevelSchema` (line 420): add `"editor"` →
  `v.picklist(["owner", "manager", "agent", "editor"])`.
- Leave `STAFF_ADMIN_LEVELS` (line 423) as `["owner", "manager"]` — see decision 1.
- Update the doc comment (lines 413-419, 439) to describe the editor role.
- Consider a helper/constant for "content roles" that may edit listings/groups/
  site, e.g. `CONTENT_ADMIN_LEVELS = ["owner", "manager", "editor"]`, to avoid
  repeating the triple across gates (keeps jscpd at 0%).

**`src/features/admin/users.ts:63`** — add `"editor"` to `VALID_ADMIN_LEVELS`
and to the invite form's role options.

### 3. Auth policies & route gating

**`src/features/auth.ts`** — add presets mirroring the existing ones:

- `EDITOR_CONTENT_FORM` (or reuse a `CONTENT_ADMIN_LEVELS` array):
  `{ body: "form", roles: ["owner", "manager", "editor"] }` for listings/groups
  create-edit routes.
- No API preset for editors — they get nothing with `allowApiKey`.

Then widen exactly these route gates to include `editor`:

- **Listings (create/edit only)** — `src/features/admin/listings.ts` /
  `listings-edit.ts`: `GET/POST /admin/listing/new`, `POST /admin/listing`,
  `GET/POST /admin/listing/:id/edit`, `GET /admin/listing/:id/duplicate`. The
  listings **list** page (`GET /admin/listings`) so they can pick one to edit.
- **Groups (all CRUD)** — `src/features/admin/groups.ts`: `GET /admin/groups`,
  `GET /admin/group/new`, `POST /admin/group`, `GET/POST
  /admin/group/:groupId/edit`, `POST /admin/group/:groupId/delete`.
- **Site content** — `src/features/admin/site.ts:104,191`: change `requireOwnerOr`
  to a gate that admits `owner` + `editor` (and manager if decided). Routes:
  `GET/POST /admin/site`, `/admin/site/contact`, `/admin/site/order`.

**Explicitly do NOT widen** (these stay on the default staff/owner gates, which
already exclude editors):

- Any attendee route — `attendees.ts`, `attendee-form-routes.ts`,
  `listings-export.ts` (CSV), and `GET /admin/listing/:id` (the attendee-centric
  listing **view** page). Editors reach editing via the list → edit link, never
  the attendee view.
- Ledger (`ledger.ts`), users/sessions/API keys, all `POST /admin/settings/*`,
  statuses/privacy/questions/logistics/emails/holidays/backup/update/debug,
  deliveries, scanner/check-in, every `ADMIN_API`/`OWNER_API` JSON route.

Because the private key is absent, even a missed gate on a PII page fails closed:
the page throws `SessionKeyError` and bounces to re-auth rather than leaking PII.

### 4. Navigation

**`src/ui/templates/admin/nav.tsx`**

- `topLevelItems` (lines 90-109) currently shows the full staff set to every
  non-owner. Make it role-aware so an `editor` session sees only: Home/Dashboard,
  **Listings**, **Groups**, and **Site** (surface the site editor as a reachable
  link for editors — e.g. promote it to top-level for editors, or keep a
  Settings parent whose only child is Site).
- Honor the **"never render a dead or forbidden link"** rule: editors must not
  see Attendees, Calendar/Servicing, Users, Ledger, Modifiers, or general
  Settings links.
- `resolveSection` / sub-navs: ensure the Site third-level (`siteSub`,
  lines 156-160) is reachable for editors without dragging in the rest of
  `settingsSub` (which links owner-only pages).

### 5. Landing page / dashboard

**`src/features/admin/dashboard.ts:79-81`** currently redirects `agent` →
`/admin/deliveries`. The dashboard surfaces ledger/income figures editors must
not see. Recommended: **redirect `editor` → `/admin/listings`** (simplest, and
keeps ledger numbers off their screen). Alternative: a minimal editor dashboard
with no financials — more work, flagged as an open question.

### 6. Modifiers (note)

Modifiers (`src/features/admin/modifiers.ts`) attach pricing to listings. The
brief lists only listings, groups, and site content — so **modifiers stay
excluded** unless we decide listing editing is incomplete without them (see
[Open questions](#open-questions)).

## Testing plan

Per repo standards (100% coverage, mutation-resistant, regression-first):

- **Key model**: an editor session yields `getRequestPrivateKey() === null`; any
  attendee/PII page rendered as an editor throws `SessionKeyError` → re-auth.
- **Activation**: invite → activate an editor sets a password, leaves
  `wrapped_data_key NULL`, and the new activation path is single-use (race/replay
  no-ops).
- **Login**: an editor with `wrapped_data_key NULL` logs in and gets a session
  with no data key (no crash in the v2-KEK migration path).
- **Route gating (positive)**: editor can GET/POST listing create+edit, group
  CRUD, and all three site editor pages.
- **Route gating (negative — the important ones)**: editor is `403`/redirected on
  every attendee route, ledger, users, settings POSTs, deliveries, and **all API
  routes** (`ADMIN_API`/`OWNER_API` with a Bearer token forged for an editor must
  be rejected). Test these *rendered/authorized as an editor*, not just as owner
  — per the "blind spot" note in AGENTS.md.
- **Navigation**: rendering the admin nav as an editor emits only the
  Listings/Groups/Site links and **no** forbidden links (dead-link rule).
- **Role downgrade**: downgrading a user to editor removes private-key access on
  their next session (metamorphic/security test).

## Open questions

1. **Manager + Site editing.** Site editing is owner-only today. Adding `editor`
   is required; should `manager` also gain it while we are there, or stay as-is?
   (Default assumption: leave manager unchanged — only add `editor`.)
2. **Listing delete / duplicate for editors.** Brief says "create and edit." Do
   editors get **delete** and **duplicate** too? (Default assumption: allow
   duplicate, allow delete — but flag, since delete is destructive.)
3. **Modifiers.** Should editing a listing's price modifiers be in scope?
   (Default assumption: no — out of scope.)
4. **Editor dashboard vs redirect.** Redirect to `/admin/listings`, or build a
   minimal financial-free dashboard? (Default assumption: redirect.)
5. **I18N / role labels.** New translation keys for the "Editor" role label in
   the user-management UI and any role pickers.

## Files touched (summary)

| Area | File(s) |
| --- | --- |
| Role enum / constants | `src/shared/types.ts` |
| User create / invite / activate / login | `src/shared/db/users.ts` |
| Private-key derivation (tests only) | `src/shared/session-private-key.ts` |
| Auth policies & presets | `src/features/auth.ts` |
| User management UI / valid levels | `src/features/admin/users.ts` |
| Listings gates | `src/features/admin/listings.ts`, `listings-edit.ts` |
| Groups gates | `src/features/admin/groups.ts` |
| Site editor gates | `src/features/admin/site.ts` |
| Dashboard redirect | `src/features/admin/dashboard.ts` |
| Navigation | `src/ui/templates/admin/nav.tsx` |
| Translations | i18n message files (role label) |
