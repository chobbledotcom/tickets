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

This is the riskiest area because a **keyless activated user** is a brand-new
shape the current invite → activate → login → status pipeline does not handle. It
spans four files, not just `users.ts`.

**`src/shared/db/users.ts`** — create / activate

- Invite with `invite_wrapped_data_key = NULL` (no handoff). `createInvitedUser`
  already accepts a null handoff (`users.ts:238-254`).
- `acceptInvite` (`users.ts:343-365`) currently *requires* a handoff (it unwraps
  `inviteWrappedDataKey` and is guarded on `IS NOT NULL`). Add a sibling
  activation function for editors that sets `password_hash`, leaves
  `wrapped_data_key = NULL`, and clears the invite — guarded so it is single-use
  and cannot be used to wipe a normal user's key.

**`src/features/join.ts`** — accept the null-handoff invite *(verified gap)*

- `/join/:code` validation rejects an invite when the handoff is missing —
  `join.ts:61-62`: `if (!user.invite_wrapped_data_key) { return htmlResponse(
  joinErrorPage(...invite_invalid...), 404); }`. An editor invite deliberately
  has no handoff, so it would be rejected *before* any new activation helper
  runs. The join route must branch on the invited user's role: allow a
  null-handoff invite for editors and dispatch to the no-DATA_KEY activation
  path, while **still** rejecting null/legacy handoffs for non-editor invites.

**`src/features/admin/auth.ts`** — the login session path *(verified gap)*

- The login flow lives here, **not** in `users.ts`. On success it calls
  `createLoginSession(dataKey, userId, adminLevel)` (`auth.ts:60-62`), whose
  first parameter is a non-null `CryptoKey` it wraps into the session. Before
  that, `auth.ts:133-135` does `if (!user.wrapped_data_key) { return
  fail("/admin", t("error.account_not_activated")); }` — so today a keyless user
  is treated as *not activated* and can never log in.
- The plan must: (a) recognise an activated editor (password set, invite
  cleared, `wrapped_data_key NULL`) as activated rather than hitting
  `account_not_activated`, and (b) allow `createLoginSession` to build a session
  with **no** data key (make the `CryptoKey` parameter optional / add a keyless
  variant), yielding a session with `wrapped_data_key = NULL`. The resulting
  session simply gives `getRequestPrivateKey() → null`. This is the single most
  important branch to get right and test.

**`src/features/admin/users.ts` + `src/ui/templates/admin/users.tsx`** — status
display *(verified gap)*

- User status is derived from `hasDataKey = user.wrapped_data_key !== null`
  (`users.ts:111-118`), and `userStatus` (`users.tsx:63-69`) maps no-data-key to
  `invited`/`expired`. An activated keyless editor would therefore display as
  *invited* forever. The activation predicate must distinguish "activated editor
  (password set, invite cleared, no key)" from "outstanding invite (no password
  yet)" — e.g. key off the cleared invite + present password rather than the
  presence of a data key.

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
- **`ANY_USER_FORM` must include `editor`** *(verified gap)*. It is hardcoded to
  `["owner", "manager", "agent"]` (`auth.ts:258-261`) and `POST /admin/logout`
  uses it (`admin/auth.ts:169`). Without this, an editor could open the logout
  confirmation but the submit would `403`. Add `editor` to `ANY_USER_FORM` (it is
  the "any authenticated user" gate, so editors belong) — and audit every other
  explicit `roles:` list for the same omission, since `editor` is not picked up by
  the `STAFF_ADMIN_LEVELS` default.

Then widen exactly these route gates to include `editor`:

- **Listings (create/edit only)** — `src/features/admin/listings.ts` /
  `listings-edit.ts`: `GET/POST /admin/listing/new`, `POST /admin/listing`,
  `GET/POST /admin/listing/:id/edit`, `GET /admin/listing/:id/duplicate`. The
  listings **list** page (`GET /admin/listings`) so they can pick one to edit.
- **Secondary listing-edit actions** *(verified gap)* — the edit page also posts
  to `POST /admin/listing/:id/children` (`listings-parents.ts:379`, `AUTH_FORM`)
  and `POST /admin/listing/:id/image/delete` /
  `POST /admin/listing/:id/attachment/delete`
  (`listings-uploads.ts:181,213,218`, `AUTH_FORM` = staff-only). These render as
  live forms on the page editors are allowed to use, so they must **either** be
  widened to the editor content gate **or** hidden for editors. Leaving them on
  `AUTH_FORM` produces dead/forbidden forms on the editor's own edit page.
- **Groups (create/edit)** — `src/features/admin/groups.ts`: `GET /admin/groups`,
  `GET /admin/group/new`, `POST /admin/group`,
  `GET/POST /admin/group/:groupId/edit`. **Group delete**
  (`POST /admin/group/:groupId/delete`) is destructive and is *not* in the stated
  capability matrix — leave it gated to staff and treat granting it as an explicit
  product decision (see [Open questions](#open-questions)), the same as listing
  delete. Do **not** silently grant editors "all CRUD".
- **Site content** — `src/features/admin/site.ts:104,191`: changing the two
  `requireOwnerOr` GET guards is **not enough** *(verified gap)*. The save
  handlers are built with `settingsHandler` / `settingsToggle` in
  `settings-helpers.ts`, which wrap `OWNER_FORM` (owner-only) at
  `settings-helpers.ts:54`. Those helpers must be parameterised (accept a role
  policy) or given editor-aware variants so the POST/save path for
  `/admin/site`, `/admin/site/contact`, `/admin/site/order` admits `owner` +
  `editor`. Otherwise editors can open the Site pages but get `403` on save.

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

### 3a. Role-aware rendering (so editors hit no dead/forbidden links) *(verified gaps)*

Gating routes is not sufficient — several pages editors *can* open still render
links/controls that point at routes they *cannot* reach, violating the
"never render a dead or forbidden link" rule. Each needs role-aware rendering:

- **Listing edit page income/ledger sections.** The edit template
  (`src/ui/templates/admin/listings.tsx`) always renders
  `ListingIncomeAdjustSection` and `ListingRunningTotalsSection` — projected
  income, a link into the income ledger, and ledger-backed adjustment controls.
  Editors must not see income/ledger data, so these sections must be omitted when
  the viewer is an editor (pass the role into the template and skip them).
- **Listings list row link.** The name column links to `/admin/listing/:id`
  (the attendee-centric detail page), and the default column set includes
  `revenue`, `cost`, `profit` (`shared/columns/listing-columns.ts:19,133-143`).
  For editors the list must drop the financial columns and link the name to the
  **edit** page instead of the forbidden detail page.
- **Groups list row link.** Rows link to `/admin/groups/:id`, and that group
  detail route calls `requireRequestPrivateKey()` (`groups.ts:178`) — it would
  throw `SessionKeyError` for a keyless editor. For editors, link rows to the
  group **edit** page instead.

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
keeps the dashboard's ledger numbers off their screen). Alternative: a minimal
editor dashboard with no financials — more work, flagged as an open question.

> **Caveat** *(verified gap)*: `/admin/listings` is only a *safe* destination
> once the role-aware rendering in §3a is done — by default the listings table
> shows `revenue`/`cost`/`profit` and links to the attendee detail page. The
> redirect target and the column/link changes must ship together, or the "safe"
> landing page leaks exactly the financial data the dashboard redirect was meant
> to avoid.

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
- **Logout**: an editor can submit `POST /admin/logout` (regression for the
  `ANY_USER_FORM` widening) — not just view the confirmation.
- **User status**: an activated keyless editor displays as *active*, not
  *invited*/*expired*, on the users page.
- **No dead links/controls**: rendered as an editor, the listings list links the
  name to the edit page and omits revenue/cost/profit; the groups list links to
  edit; the listing edit page omits the income/ledger sections.
- **Role downgrade**: downgrading a user to editor removes private-key access on
  their next session (metamorphic/security test).

## Open questions

1. **Manager + Site editing.** Site editing is owner-only today. Adding `editor`
   is required; should `manager` also gain it while we are there, or stay as-is?
   (Default assumption: leave manager unchanged — only add `editor`.)
2. **Listing delete / duplicate for editors.** Brief says "create and edit." Do
   editors get **delete** and **duplicate** too? (Default assumption: allow
   duplicate; **leave delete to staff** since it is destructive.)
2a. **Group delete for editors.** Same question for `POST
   /admin/group/:groupId/delete`. Destructive and not in the capability matrix.
   (Default assumption: leave to staff.)
2b. **Secondary listing-edit actions** (required-children, image/attachment
   delete). Widen these to editors so the edit page is fully usable, or hide the
   controls for editors? (Default assumption: widen — they are content edits to a
   listing the editor already owns the edit page for.)
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
| User create / invite / activate (keyless) | `src/shared/db/users.ts` |
| Join: accept null-handoff editor invite | `src/features/join.ts` |
| Login session for keyless user | `src/features/admin/auth.ts` (`createLoginSession`, `account_not_activated` branch) |
| User status predicate (activated vs invited) | `src/features/admin/users.ts`, `src/ui/templates/admin/users.tsx` |
| Private-key derivation (tests only) | `src/shared/session-private-key.ts` |
| Auth policies & presets (incl. `ANY_USER_FORM`) | `src/features/auth.ts` |
| User management UI / valid levels | `src/features/admin/users.ts` |
| Listings gates | `src/features/admin/listings.ts`, `listings-edit.ts` |
| Listing secondary-action gates | `src/features/admin/listings-parents.ts`, `listings-uploads.ts` |
| Groups gates | `src/features/admin/groups.ts` |
| Site editor gates (GET **and** POST helpers) | `src/features/admin/site.ts`, `settings-helpers.ts` |
| Role-aware rendering (income/ledger sections, list columns/links) | `src/ui/templates/admin/listings.tsx`, `src/shared/columns/listing-columns.ts`, groups list template |
| Dashboard redirect | `src/features/admin/dashboard.ts` |
| Navigation | `src/ui/templates/admin/nav.tsx` |
| Translations | i18n message files (role label) |
