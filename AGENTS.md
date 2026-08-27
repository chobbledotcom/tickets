# tickets

A minimal ticket reservation system using Bunny Edge Scripting and libsql.

## Getting Started

Assume the workspace is probably running on NixOS. Use the repository's Nix
development shell so Deno and the other tools come from `flake.nix`:

```bash
nix develop
```

For one command, run it through the shell instead of entering it:

```bash
nix develop -c deno task precommit
```

Do not use `mise` or a host-installed `deno` directly when Nix is available. All
`deno ...` commands in this file assume you are already inside `nix develop`;
non-interactive agents must prefix them with `nix develop -c`. On systems
without Nix, `./setup.sh` remains the fallback.

## Runtime Environment

- **Production**: Bunny Edge Scripting (Deno-based runtime on Bunny CDN)
- **Development/Testing**: Deno (for `deno task test`, `deno task start`,
  `deno coverage`, package management)
- **Build**: `esbuild` with `platform: "browser"` bundles to a single
  edge-compatible file

Code must work in both environments. The edge runtime is Deno-based, so
development with Deno ensures parity.

## Deno Version

This repo pins Deno 2.5.6, the lowest Bunny Edge Scripting runtime version this
project is expected to run on. Local development must use that version too.

The Nix flake pins the required Deno version. Check it with:

```bash
nix develop -c deno --version
```

The `.tool-versions` and mise configuration are kept in sync only for
environments without Nix.

## stripe-mock

The test harness needs the `stripe-mock` binary at `.bin/stripe-mock`. The
standard runners (`deno task test`, `deno task test:files`, and `--harness`
mutation runs) start one stripe-mock process on a free local port and export
`STRIPE_MOCK_HOST/PORT` to their child test processes, so parallel suites do not
fight over port 12111. The harness normally downloads a prebuilt release from
GitHub, but in sandboxes where GitHub release downloads are blocked you can
build it from source with Go instead — the Go module proxy is usually reachable
when GitHub is not:

```bash
GOBIN="$PWD/.bin" go install github.com/stripe/stripe-mock@v0.188.0
```

Pin the same version the harness expects (`STRIPE_MOCK_VERSION` in
`scripts/stripe-mock/install.ts`). Once `.bin/stripe-mock` exists the harness
uses it as-is and skips the download, so `deno task test`,
`deno task test:files`, and `--harness` mutation runs all work offline from
GitHub.

## Preferences

- **Plan behavior before code**: Follow [PR_WORKFLOW.md](PR_WORKFLOW.md) for
  every non-trivial change. The assigned agent must fill in the behavior
  contract, challenge it, and ask a human to approve it before implementation.
  The contract covers trusted facts, valid states, commands, failures, retries,
  races, and owner choices. Schemas describe facts, state transitions describe
  changes, and transactions or revision checks protect concurrent changes. Do
  not start coding while any part is implicit or awaiting human approval.
- **Once it is built, the code is the authority**: A behavior contract governs
  work that does not exist yet. The moment a slice lands, its code and tests
  become the truth, and the contract's job changes from _specifying_ that slice
  to _pointing at_ it: as each slice merges, update the plan's module map to
  name the real files and exported names, and say where the built thing
  knowingly differs from what was planned. From then on, check every finding,
  question, or proposed amendment against the actual `src/` and `test/` before
  touching the document — when the built behavior is wrong, fix the code and pin
  it with a regression test instead of rewriting prose to describe the bug.
  Amend the contract only when the _contract_ is what is wrong (it promised the
  wrong behavior, or it contradicts a constraint the implementation just
  proved), and then change the document and the code in the same commit. A plan
  that keeps describing an implementation that already exists has quietly become
  a second, drifting source of truth — and the drift is always discovered by
  someone trusting the wrong one.
- **Format Markdown with Deno**: Let `deno fmt` apply its standard 80-column
  wrapping to Markdown files. Do not hand-wrap prose to a different width or
  unwrap paragraphs onto single long lines. Formatter exceptions such as tables,
  code blocks, and long links can exceed 80 columns.
- **Write technical text in Simplified Technical English**: Documentation,
  READMEs, runbooks, procedures, release notes, reports, commit messages, pull
  request descriptions, and developer-facing error messages follow ASD-STE100.
  Classify the passage first. Procedural text uses the imperative and a maximum
  of 20 words per sentence. Descriptive text uses simple tenses and a maximum of
  25 words. Use only `can`, `will`, and `must` as modals. Do not use
  contractions, semicolons, the present perfect, or "-ing" verb forms. See
  [Simplified Technical English](#simplified-technical-english--how-we-write-documentation)
  for the full rules. Copy inside the app is different, and follows
  [Simple Language](#simple-language--how-we-talk-to-users).
- **Use FP methods**: Prefer curried functional utilities from `#fp` over
  imperative loops
- **Plain language for functional code**: Keep the functional style, but name
  helpers and write comments in simple domain words. Avoid CS jargon in code
  (`predicate`, `cohort`, `projection`, `fold`, `atom`, etc.) when a plain
  phrase works. A helper must explain itself like "Keeps only children that can
  still be booked for this ticket." Write for someone without a CS degree; a
  ten-year-old must understand the comment and the method name, even if the
  implementation uses `map`, `filter`, or `reduce`.
- **Name a thing the way the site names it**: A story, a test, or a comment
  calls a thing what its label, its message, or its column heading calls it. The
  site says "Username", so a story says "the owner is told the username is
  taken", never "the name is taken". A reader must be able to carry a word from
  the story to the screen. "A name" is ambiguous here, because attendees,
  listings and groups all have names too. Copy the word a person reads in
  `src/locales/en/*.json`. Never copy the identifier beside it in `src/`. An
  HMAC, a token index, and a `package_group_id` all stay out of a story. Two
  things are not drift. A plain-words description of an outcome is right, so
  "who has not joined yet" beats the status word "Invited". A general word is
  right where the rule itself is general, so a bundle holds "things" because
  that rule covers every kind of listing. Keep one word for one thing inside a
  single document too. `removing-a-persons-access.feature` is the reference: the
  word the owner types, the word in its prose, and the word its step asserts are
  one word. A better word never moves an authored tag. A `@story:`, `@rule:` or
  `@case:` id is a durable identifier. A saved `--tags` selector or a published
  evidence manifest can point at one. The id stays as it is while the words
  above it improve. No checker enforces this, so the judgement is yours on every
  change.
- **Comments describe current code**: Do not leave comments that compare current
  code with an old implementation or explain what the code replaced. They do not
  help someone understand the code as it works now. Git history preserves the
  old code if anyone needs it. Delete stale historical comments when you find
  them.
- **Comments are short, because the code says the rest**: Well-named methods and
  values already say _what_ the code does, so a comment only needs to add what
  the reader cannot see — a _why_, a constraint, a surprise. One or two lines is
  the norm; a paragraph above a few lines of code is a smell, and usually a sign
  that the code needs to be clearer instead. Never re-narrate the lines below in
  prose, never restate a name (`/** Save the listing. */` above `saveListing`),
  and never explain a language feature. If a comment grows to explain a tangle,
  fix the tangle: rename the thing, or pull the confusing part into a named
  helper whose name carries the explanation. The bar to clear is this question:
  is a competent reader surprised or misled without the comment? If the answer
  is no, delete the comment. This applies to prose in commit messages and PR
  descriptions too: say what changed and why, then stop.

  `deno task check:comments` enforces the size half of this, since Biome never
  reflows comment text and so has never held a comment to any width. It caps the
  lines in one comment and the columns in one comment line, exempting only the
  machine-read directives, the `deno doc` barrels, and shipped migrations, which
  are history. **Both numbers ratchet downward** — lower the one in
  `scripts/check-comments/run.ts`, bring the tree to it, repeat — so no file is
  ever grandfathered. `docs/comment-policy.md` measures what the comments cost
  and prices each remaining step. The judgement half is still yours: no checker
  can tell whether a comment earns its place.
- **Zero code duplication**: jscpd runs at a non-negotiable 0% threshold. Fix
  duplication with a helper or currying — see
  [Code Duplication](#code-duplication). `jscpd:ignore` is reserved for import
  blocks, essentially nothing else. The warning is a _positive signal_ pointing
  at a real merge to make — never work around it by changing a structure so the
  matcher stops matching (config objects, namespace imports, reordering, lifting
  to a named const, all to dodge the token match) while leaving two parallel
  implementations standing. Every merge is warranted; the merges are the whole
  goal. After each dedup, zoom out and fold the new helper into other call sites
  and older siblings it now subsumes.
- **100% test coverage**: All code must have complete test coverage - run
  `deno coverage` to find uncovered lines/branches. Coverage must also be
  _deterministic_: a line or branch reached only through a spawned subprocess or
  e2e test (for example the `cli/` scripts, exercised by
  `test/e2e/cli-api.test.ts` via `deno run`) is covered non-deterministically —
  the child process's coverage is collected through `DENO_COVERAGE_DIR` and is
  environment-sensitive, so it can pass CI on one run and fail on the next. Give
  any branch that must stay covered a direct in-process unit test, not just
  incidental subprocess coverage.
- **Hardest first, no need to ask**: When the only open question is _what order
  to build several things in_, the answer is always "do the more difficult one
  first" — just proceed, do not ask.
- **Always the complete version**: When choosing between a result that is less
  accurate/complete and the full, correct version, always do the complete
  version — even if it means changing more files than originally estimated. Our
  aim is always to create the most perfect software; do not ask permission to do
  it properly.
- **Feature-complete by default**: When the open question is whether to take
  this feature all the way to complete, the answer is yes — build the whole
  thing, not a partial slice, and do not ask permission to finish it. The _only_
  reason to stop short is when finishing would genuinely complicate the
  codebase: more branching, more special cases, a worse overall shape. That
  trade-off — completeness against simplicity — is the sole deciding factor;
  never the effort or the number of files touched. If the two genuinely pull
  apart, say so explicitly and let the codebase's health break the tie.
- **Unify systems — the answer is yes**: When the question is whether to unify
  two systems, or collapse two paths into one, the answer is yes. A core aim is
  to _reduce the lines of code_ needed to accomplish the same thing: the
  codebase has a finite size it must stay within, so it is critical we reuse and
  refactor toward one shared mechanism rather than maintain two parallel ones.
  Two things doing almost the same job are a standing invitation to find the
  single abstraction that does both — take it. The recent `serve-app.ts`
  extraction is the reference: it collapsed the Bunny edge and Deno Deploy entry
  points onto one shared production request handler, leaving
  `edge.ts`/`deploy.ts` as thin platform wrappers.
- **No alias exports — expose the shared mechanism itself**: Never export a name
  that is just another name for an existing method
  (`export const getChildIds = byParent.getIds`). Expose the underlying
  helper/object directly and let callers use it
  (`listingChildren.getIds(parentId)`). Exposing our internals is a feature: it
  encourages us to make them universal, understandable, and neat, while an alias
  layer hides the one shared mechanism behind per-module vocabulary and gives
  the same behavior two names. A thin wrapper that _adds_ something — a default,
  a transformation, a guard — is not an alias and is fine.
- **No internal compatibility layers**: We own every internal caller. When
  replacing an internal API, migrate every caller in the same change and delete
  the old surface instead of keeping wrappers, aliases, re-exports, or
  "compatibility" shims. Keep adapters only at true external boundaries
  (provider APIs, serialized data/import formats, browser/platform contracts) or
  for an explicitly staged data migration with a named removal path.
- **Imports name a module one way**: A module has one spelling, and every file
  reaches it with one statement. The spelling is the shortest alias in the
  `deno.json` import map that reaches the file, so `#db/client.ts` beats
  `#shared/db/client.ts` and `#types` beats `#shared/types.ts`. A file must not
  import the same module twice: put the type-only names in the same statement
  with an inline `type`, as in
  `import { type Result, okResult } from "#shared/result.ts"`. A namespace
  import beside named ones is the one allowed pair, because it reads the whole
  module on purpose. `deno task check:imports` enforces both rules, and reads
  the alias table out of `deno.json`, so a new alias enforces itself.

  An alias is a build-time rename with no runtime cost, but it is also a second
  name for a folder everybody already knows. Add one only when the measured
  saving pays for that: each alias in the table today removes 50 or more wrapped
  import lines. Below that bar, leave the module under `#shared/`.
- **Remove dead code — always the answer**: When code has no production caller —
  an unused export, an unreferenced helper, a guard/page whose only consumer is
  itself unused, an unreachable branch — delete it. Removal is _always_ the
  right call; never keep it "for symmetry" or "for future use" (add it back when
  the future arrives, from git history), and never paper over it with a
  test-only import or a lint/usage-check exemption. If a check surfaces an
  export that is used only by tests, that is a signal the export is dead, not a
  reason to allow-list it: remove the export (and its now-pointless test). A
  symmetric-but-unused API is still dead code. The reference:
  `agentPage`/`requireAgentOr` were an agent-only page+guard pair with no route
  wiring (agents are gated via `deliveryPage`/`requireDeliveryOr`), so both were
  deleted rather than exempted.
- **Keep code and test files under ~400 lines**: When refactoring a code or test
  file, aim to keep it under 400 lines — and if hitting that target means
  splitting one file into several, so be it: a new file is cheaper than an
  overloaded one. When you end up with a handful of files all about the same
  thing, group them in a folder and give them shorter names that do not repeat
  the folder's name (`ledger/project.ts`, not `ledger/ledger-project.ts` — see
  the `src/shared/ledger/` and `src/shared/db/attendees/` examples in
  [Modularised](#modularised)). While you are at it, use the split as a chance
  to separate pure from non-pure code — push the data-in/data-out logic into its
  own file and keep the IO in a thin shell (see
  [Pure, functional](#pure-functional)). **The same 400-line limit applies to
  test files**, and matters just as much: smaller, more specific test files let
  us run mutation tests far faster, because a source file's mutants only need to
  run against the narrow test file that covers it, not one giant suite. Biome
  enforces a hard 1,000-line ceiling for every code and test file; never add an
  override to let one past it. Root instruction files such as `AGENTS.md` are
  exempt because their policy must be available as one automatically loaded
  document, but their sections must still stay concise. (Expect a known side
  effect when splitting: jscpd cannot fully scan very large files, so a split
  routinely _surfaces_ duplication that was silently passing inside the monolith
  — budget for extracting helpers, not just moving tests.)
- **Good citizen — fix what you spot**: If you notice a bug, a coverage gap, or
  a flaky/fragile test while working — even in code you were not asked to touch
  and did not write — fix it in passing rather than stepping around it. A green
  build you helped produce is your responsibility too.
- **A written-down diagnosis is a hypothesis, not a finding**: A `TODO.md`
  entry, a review comment, a commit message, or a code comment explaining why
  something breaks was written by someone reasoning about the code at a moment
  that has passed. Re-derive it from the current source before you fix anything,
  however confident and detailed it reads — a wrong diagnosis is more expensive
  than none, because it aims your fix at the wrong place and takes the
  regression test with it. The stripe-mock port-steal entry in `TODO.md` is the
  worked example: it was a careful, plausible, thoroughly argued account of a
  race in the wrong function, and following it would have "fixed" code that was
  already correct while leaving the real hazard in place. When you find one
  wrong, correct the note in the same change — leaving it sends the next person
  down the same path.
- **A finished job leaves `TODO.md`**: `TODO.md` holds work that is still open.
  When you complete an entry, delete it in the same change. Never leave it in
  place marked "done", "fixed", or "shipped". A reader must be able to trust
  that every entry is work somebody can still pick up, so a list of finished
  ones costs every later reader the time to work out which is which. The commit
  message and the pull request are the record of what you did, and git history
  holds the entry itself. The same applies to an entry you did not write: when
  you find one the code already answers, check it against the current source,
  then delete it. An entry stays only when part of it is still open, and then
  only that part stays. The one exception is an entry this file cites as a
  worked example, such as the stripe-mock port-steal note. That entry is
  documentation, not a job.
- **Stage what you changed, never `git add -A`**: Name the files you meant to
  touch, and read `git status --short` before committing. A blanket add cannot
  tell your work from a stray tool run, a build artefact, or a formatter that
  rewrote a thousand files you never opened — and a commit is where that stops
  being recoverable quietly. If the file list surprises you, that surprise is
  the point: find out why before you commit, not after a reviewer counts the
  diff.
- **Judge nothing from a stale base ref**: `git fetch origin main` before you
  read a `origin/main...HEAD` diff, count changed lines, or run the mutation
  gate. A local `origin/main` left behind by a few merges makes an unrelated
  branch look like it rewrote the tree, and every conclusion drawn from that —
  what a PR contains, how big it is, what needs mutating — is wrong in the
  alarming direction.
- **A red check is not automatically yours**: Before treating a CI or status
  failure as your breakage, ask what it can possibly have to do with your diff,
  and look for a control. A sibling build of the identical commit that
  succeeded, a failing test your files cannot reach, a provider outside the
  repository — each is evidence that the cause is elsewhere, and none is proof.
  A sibling passing shows the failure is nondeterministic or depends on its
  environment, which a real bug in your own code can also be, so trace the
  failing path far enough to name the cause before setting it aside. Say so,
  once, with the evidence rather than the word "flaky", and keep going. This
  never licenses ignoring a failure: not yours still means diagnosed, reported,
  and re-run.
- **Every bug fix ships with a regression test**: Never fix a bug without also
  adding a test that fails before the fix and passes after it. The test must
  exercise the real bug — reproduce the exact condition that was broken so it
  would have caught the original defect — not merely touch the changed lines for
  coverage. Write the failing test first, confirm it fails for the right reason,
  then apply the fix and watch it go green. This locks the bug out for good and
  proves the fix actually addresses it.
- **Offensive, not defensive, programming**: Fail loudly and immediately instead
  of tolerating bad states — never suppress, default away, or paper over an
  error. See
  [Offensive Programming](#offensive-programming--never-suppress-errors) for the
  full rules.
- **Attribute money to its true item at write time — plan so data never needs a
  migration**: A migration can add a column, but it cannot recover a fact we
  never stored, and a data-repair migration is the gnarliest change we ship — it
  runs once, on every site, against data we cannot see, and a bad one stops an
  upgrade. Treat "we can fix the records up later" as a design smell: a money
  movement lands against its true money item on the day it happens, never
  against a placeholder or a wrong identity that a future migration must
  re-attribute. Prefer additive schema and correct attribution now over stored
  rewrites later.
- **Trust application invariants**: Do not design normal code paths around
  database states the application says are impossible. If an impossible state is
  observed, raise it as an error and repair the data explicitly rather than
  silently accepting or normalising it.
- **Do not defend against the impossible**: Do not add fallbacks, placeholders,
  or `try/catch`es for failures that can only happen when a foundational system
  is already broken — the encryption/data key will not decrypt, the database has
  vanished, a core invariant the app guarantees is violated. You will never
  reach such a branch without the whole app already being down: you cannot
  render a page whose data will not decrypt, because the _same_ key protects the
  attendee's own PII, so the request dies long before your guard runs. Such a
  guard only hides a system-wide failure behind an untestable, never-exercised
  branch (and a coverage gap). Let it throw, loudly. Reserve resilience for
  failures that genuinely occur in normal operation — a flaky network call, a
  provider timeout, a refund that already settled, a write that lost a race. Be
  confident in our own systems.
- **Trust request key setup**: If the site is processing a request, startup has
  already validated `DB_ENCRYPTION_KEY`. If it is processing any route other
  than setup, the atomic setup ceremony has already created the owner and public
  key. Do not spend CPU cycles or source bytes checking that either key exists
  in request code, and do not test states that can only be made by corrupting
  this setup.
- **One path for one-or-many — a single item is an array of one**: Do not write
  a separate "single" code path beside a "multiple" one (no `getThing(id)` next
  to `getThings(ids)`, no `length === 1` branch that renders/loads/books
  differently from the N-item case). Model the operation over a collection once
  and call it with an array of one when there is a single item; derive the
  singular answer from the array result
  (`(await getHiddenPackageMemberIds([id])).size > 0`). A thin singular wrapper
  that _delegates_ to the array implementation is fine (it is still one path);
  two parallel implementations that can drift are not. The multi-group
  membership refactor is the reference: a listing's groups are always an array,
  never a special-cased single `group_id`. This keeps behaviour identical for 1
  and N, and kills the class of bug where the single case is fixed but the batch
  case is not (or vice-versa).
- **Schema over organic structure**: Prefer a declarative schema plus functional
  composition (map/filter/`compact` over data) to hand-nested or imperative
  construction — _even for content that looks organic_, like help/FAQ pages,
  navigation, form layouts, or report sections. Model the thing as data (a typed
  list of sections/entries/fields), render it with one shared function, and let
  the types make invalid arrangements unrepresentable. The admin guide
  (`src/ui/templates/admin/guide/`) is the reference example: each topic exports
  a `GuideSection[]`, `renderGuideSections` turns it into markup, and because a
  section's `entries` can never be a section, a sub-section cannot be mis-nested
  mid-list and drag unrelated questions under the wrong heading. When you catch
  yourself authoring repetitive nested JSX/markup by hand, lift it into a schema
  first.
- **Shared interfaces over branch-per-case**: Prefer one tightly-defined shared
  interface that every case implements over a chain of "if this kind of
  situation, do this; else that". Branch-per-case does not grow naturally — each
  new case is another arm bolted onto every dispatcher, and a forgotten arm
  fails silently rather than loudly. Model the cases as data instead: a typed
  union plus an _exhaustive_ `Record` keyed by it (so a new case is a compile
  error in every dispatcher), or per-entry predicates/handlers that carry their
  own rules, folded over uniformly. Schema-tizing this way is always a good end
  — it turns invalid arrangements into unrepresentable ones and makes the system
  additive to extend. The recent listing-defaults work is the reference: its
  `kind` dispatch was rewritten from parallel if/ternary chains (each silently
  falling through to a default arm) into exhaustive `Record` maps, and
  `resolveListingDefaults` became a plain fold over `LISTING_DEFAULT_FIELDS`
  whose per-field `appliesTo` predicates replaced the inline
  `if logistics-off / if renewal-tier` special-casing — the invariants now live
  with the fields they guard.
- **Malleable software**: Prefer being up front with operators about the
  underlying data structure over hiding it. Where it is safe, expose stored
  records directly and give the operator a page to view and edit them —
  including aggregated/derived numbers — rather than treating the DB as a black
  box. The per-contact record editor at `/admin/history/:hmac` (raw
  booking/message counts plus the private note, keyed by the contact's HMAC) is
  the reference example. Repairing data must be a first-class operator action,
  not manual DB surgery.
- **Never render a dead or forbidden link**: Do not emit a link the viewer
  cannot follow — one whose target returns 404, or whose page the current user's
  admin level cannot open. A rendered link is a promise that it works, so gate
  it on the same condition the target enforces; when that condition fails, show
  plain text or an indicator in its place rather than a link that breaks on
  click. The no-quantity attendee's ticket cell is the reference: a
  quantity-0-only attendee has no live `/t` page (it 404s), so admin views
  render a "No quantity" indicator instead of the `/t` link. This holds for
  permission-gated links too: an action a role cannot reach must not be linked
  for that role. Mind the blind spot — a link to a restricted page still works
  when the page is viewed (or tested) as a high-privilege user, so the dead link
  the lower-privilege roles see goes unnoticed. Gate the link on the same
  permission the target enforces, and when testing visibility, render the page
  as each role rather than only the most-privileged one.
- **Operator decides genuine conflicts — a required choice, never a silent
  default**: When an action hits a conflict the system cannot unambiguously
  resolve (for example an attendee merge where both records booked the same
  listing, or where each side carries a real payment), do NOT auto-pick a
  resolution and quietly proceed. Surface the conflict and make the operator
  choose explicitly via a **required** field — the request fails closed until
  they decide. Silently moving money, voiding a leg, or keeping one side by
  default hides a real decision behind a guess; an explicit operator choice
  keeps the irreversible call — especially anything that touches the money
  ledger — with the human who can see the context.
- **Select only needed columns**: Avoid `SELECT *` and broad "load every row"
  helpers — query the specific columns a caller actually uses. See
  [Database Queries](#database-queries).
- **SQL table aliases**: Alias tables with the full singular word using `AS`,
  not a single letter — write `FROM listings AS listing`, never
  `FROM listings e` (the `e` is a leftover from when listings were called
  "events"). When one query references the same table more than once (for
  example correlated subqueries that compare a row against its group), give each
  occurrence a descriptive word alias — `listing` for the row being checked,
  `groupListing` for sibling rows in its group.
- **Name positional results at the boundary**: When a library returns an ordered
  array of different results, destructure it into domain names as soon as it
  enters our code. Keep the unavoidable ordering beside the call that creates
  it; do not make readers trace `results[2]` or `rows[7]` through later mapping
  code. If the number of results is not guaranteed, validate it at that boundary
  before naming the values.
- **Use types where they remove noise**: Replace repeated inline object shapes
  with a named type or interface when that makes a boundary contract clearer,
  removes repeated field declarations, or lets related shapes share a small
  base. Reuse or extend an existing type when it already describes the facts. Do
  not create a new name for a one-off shape that is already easier to read
  inline, and do not add aliases that give the same concept a second vocabulary.
- **Annotate return types on exported functions, and keep types easy to
  compile**: Give every exported/public function an explicit return type instead
  of leaning on inference. A named annotation is more compact for the checker to
  record than a re-inferred anonymous type, and it fails loudly at the
  definition when the body drifts from the contract rather than leaking a
  surprising shape to callers. This is the
  [TypeScript performance guidance](https://github.com/microsoft/TypeScript/wiki/Performance)
  applied to our checker (`deno check` is the same compiler underneath): prefer
  an `interface`/base type that others extend over a large `type X = A & B & C`
  intersection or a wide bare union (comparing many members is quadratic), and
  give a complex conditional type its own name so the compiler caches it instead
  of re-deriving it at every use. A small two-way `A & B` merge, or a
  `v.variant`/discriminated union built from the schema-first patterns above, is
  already the right shape — this is about not hand-rolling sprawling anonymous
  ones. (The wiki's `tsconfig`/project-reference/tracing advice does not apply:
  we type-check with `deno check`, not `tsc`.)
- **Never lose work — commit WIP even if broken**: Uncommitted changes are lost
  if the working environment is reclaimed (it has happened). If you have
  non-trivial work in progress and are about to pause, hand off, delegate to a
  background agent, or end a turn with a dirty tree, **commit and push it**
  rather than leaving it uncommitted. A known-broken checkpoint is fine and
  expected — mark it unmistakably in the commit message (for example
  `WIP: <chunk> — NOT GREEN, <what fails>`) so it is never mistaken for finished
  work, and follow up with a green commit. Do not hold a commit back purely
  because the tree does not yet build or pass; losing the work is worse.
- **Answer every PR review thread you address**: When a pull request review
  leaves comments — from an automated reviewer (for example Codex) or a human —
  reply to **each** thread directly with a concise, proper note: how it was
  resolved (the mechanism + the regression test that locks it), or why it is not
  actionable/incorrect. Do this even when the commit message already explains
  the change — an open thread reads as unaddressed, so close the loop on the
  thread itself. This is a deliberate exception to general GitHub-comment
  frugality: resolution replies on review threads are expected, not noise. Keep
  each reply tight (a few sentences), and reference the fixing commit. **If a
  suggestion is valid but outside the current job's scope**, do not silently
  drop it — record it in `TODO.md` with enough context for a future person to
  pick it up without re-reading the PR (the file/path it concerns, what the
  reviewer proposed, why it is genuinely out of scope here, and a starting
  point), then reply on the thread pointing to the TODO entry. Scope is a real
  boundary, not an excuse to lose good ideas.
- **"Actually broken" outranks "nice in a perfect world"**: A finding, review
  comment, or idea earns a fix when it names a concrete failure — real inputs
  and state under which behaviour is wrong: money lost or double-moved, data
  corrupted, a crash, a dead or forbidden link, a permission hole. Verify the
  scenario against the real code first; verified breakage gets the complete fix
  and its regression test. Everything else — symmetry, hypothetical drift with
  no concrete trigger, restating what a pinned test already enforces, polish
  whose only effect is making the document or code "more consistent" — is
  perfect-world work: declining it with a short reason on the thread is a
  first-class outcome, and a genuinely good idea goes to `TODO.md` rather than
  into the queue. This is triage for what enters the queue, never licence to do
  entered work partially — "Always the complete version" still governs
  everything we decide to do. Assertive automated reviewers can generate
  perfect-world findings indefinitely, so bot silence is not a finish line: when
  consecutive rounds stop naming new concrete failures, declare the review
  converged and hand the decision to a human.
- **Finish by rewriting the PR name and description**: Once a feature is done,
  revisit its pull request and update the name and description to match what was
  actually built. A PR often starts life with a WIP or work-in-flight title. The
  finished PR must be thorough, and written in the same plain words we want in
  our code, comments, and method names. Someone without a CS degree must be able
  to read the PR and know what changed, why, and what it means for the people
  using the site. Name a file, a route, or a setting when that names the change
  most clearly. The name and the description are technical text, so they also
  follow
  [Simplified Technical English](#simplified-technical-english--how-we-write-documentation).
- **Final check**: Run `nix develop -c deno task precommit` before finishing any
  job with code or documentation changes. It is the only check that mirrors CI
  exactly — it typechecks the **test** files too, so `deno check <src>` plus
  `test:files` is not a substitute (a test-only type error will pass locally and
  still break CI).

## Stacked Pull Requests

Use GitHub stacked pull requests for large, dependency-ordered work when the
repository has access to the feature. Manage them with the official `gh stack`
extension. A stack is a short linear chain in this repository: its bottom branch
targets `main`, and every higher branch targets the branch directly below it.

- Keep a stack small, normally three to seven pull requests. Split a larger job
  into several completed stacks so a low-layer change does not rebase and rerun
  CI across dozens of branches.
- Every layer must be independently green, reviewable, and useful to the system
  that will exist when that layer merges. Future reuse, tests alone, or an
  unused foundation do not justify a layer. Delete the implementation a layer
  replaces in that same layer unless it is a named mixed-version deployment
  adapter.
- Review and merge from the bottom up. Higher layers can be reviewed in
  parallel, but do not merge an upper layer while a required lower layer is
  unapproved. After a lower layer changes or merges, use `gh stack rebase` or
  `gh stack sync` rather than manually retargeting every branch.
- While a layer is above another open layer, run targeted mutation tests for the
  source changed by that layer. `precommit:mutation` compares the whole branch
  with `origin/main`, so run that branch-level gate after the lower layers merge
  and the layer has been rebased into the bottom position.
- CI runs for every branch and pull request in a stack. Avoid needless full
  stack pushes, and do not create one giant stack merely because the tool can
  display it.

## Offensive Programming — Never Suppress Errors

This codebase practices
[offensive programming](https://en.wikipedia.org/wiki/Offensive_programming),
not defensive programming. Defensive code tolerates bad states to keep running;
offensive code makes bad states impossible to miss. A loud failure is almost
always better than a silent wrong answer — the crash points at the bug, while a
swallowed error corrupts data far from the cause. "Trust application invariants"
and "Do not defend against the impossible" in [Preferences](#preferences) are
this same philosophy; the rules below are how it applies to everyday error
handling.

- **Let errors propagate.** Do not silence, swallow, or paper over them. Do not
  wrap code in `try`/`catch` just to "make it more robust" — robustness comes
  from correct assumptions, not from hiding broken ones.
- **A missing expected field from structured external data is a HARD no to
  default away.** JSON API response, database row, config, env var, webhook
  payload, fetch result, file/CLI output — if the field is documented/expected,
  missing means something is wrong upstream, and the program must fail there,
  not invent a value. Validate at the boundary with a valibot schema and pass
  typed values inward (`src/features/api/sms-webhook.ts`); where a schema is
  overkill, check and throw the way `parseMessageId` does
  (`src/shared/sms/gateway.ts` — a gateway response without a message id throws,
  it does not return `""`) and `getDb` does for a missing `DB_URL`
  (`src/shared/db/client.ts`).
- **Do not use `??` / `||` / `?.` to make a missing value someone else's
  problem.** Coercing `null`/`undefined` into `""`, `0`, or `[]` to keep the
  pipeline moving converts a detectable failure into corrupt data. These
  operators are for _genuinely optional_ values (next bullet), not for papering
  over a value that must always exist. Unchecked assertions — the non-null `!`
  and `as` casts that claim a shape the data has not been checked against — are
  a different trap: they run no code at all, they just tell TypeScript to stop
  checking, so the failure surfaces wherever the impossible value is first
  touched instead of where it went missing. Parse, do not pretend.
- **No empty `catch`, no catch-and-continue.** Only catch when there is a real
  recovery path, catch at the narrowest point that has one, and re-raise (or
  log + re-raise) otherwise. Good catches look like `parseMessageId` — a
  `JSON.parse` of an external response caught and rethrown as a specific,
  contextful error — or a boundary handler turning an invalid webhook payload
  into a 400. A `catch {}` whose body ignores the error is acceptable only when
  the fallback _is_ the documented behavior, stated in a comment (for example
  `tryDecrypt` in `src/features/api/sms-webhook.ts`, whose contract is "fall
  back to the raw value if it is not encrypted").
- **A function that looks something up, resolves, computes, or finds something
  must THROW when it cannot** — never return `null` / `""` / `0` / `-1` / `[]`
  as a "not found" stand-in — unless "not found" is a genuinely expected,
  documented outcome the caller branches on. This is the case that keeps
  recurring: a helper iterates looking for a value (an id, a match, a record)
  and falls off the end. The right tail is
  `throw new Error(...context naming what was being looked up, and in what...)`
  — see `src/shared/dates.ts` (`Invalid ${label}: ${value}`) and
  `src/shared/slug.ts` (throws when candidates are exhausted) — not a silent
  stand-in that leaks downstream. If every caller is structured so the value
  must exist (inputs already filtered to guarantee it), the miss is a bug:
  surface it loudly.
- **Defaults, optional chaining, `catch`, and nullable returns are acceptable
  only when the absence is genuinely expected and semantically meaningful.** An
  optional query-string parameter (`searchParams.get(key) ?? ""` in
  `src/features/url.ts`), an accumulator's first visit (`totals.get(key) ?? 0`),
  a record that legitimately does not exist yet. In that case, name it for what
  it is — the `*OrNull` suffix (`decryptAttendeeOrNull`, `firstRowOrNull`) and a
  `| null` return type are the house convention — and comment why the absence is
  expected, so a reader can tell a deliberate branch from a suppressed failure.

## Simple Language — How We Talk To Users

Everything the system says to a person — error messages, form intros and field
hints, column headers, buttons, warnings, alerts, success and flash messages,
empty states, confirmations — must read at roughly **Simple Wikipedia** level.
The reader to picture is someone who reads English as a second language, is
dyslexic, or is just impatient with reading. The system must never stump that
reader. Be as short and plain as you can **while still saying everything the
reader needs** — concise, never clipped.

This section is about copy inside the app. Documentation, runbooks, commit
messages, and other technical text follow
[Simplified Technical English](#simplified-technical-english--how-we-write-documentation)
instead.

This is not "dumbing down". Assume the reader understands the domain concepts
the platform runs on — a percentage, a deposit, gross vs net, a refund. Do not
stop to teach those. Explain _our system's_ behaviour in plain words, and never
pad a message with general knowledge the reader already has.

### Where the copy lives

All user-facing text is in the message catalog at `src/locales/en/*.json`,
reached through `t("key")` (see `src/shared/i18n.ts`). Changing what a user
reads is a **catalog edit, not a template edit** — the `i18n-coverage` test
(`test/scripts/i18n-coverage.test.ts`) fails the build when a new hard-coded
string appears in a template. Write copy once, in the catalog, and every surface
that shows it stays worded the same.

### How to write it

- **One idea per sentence.** If a sentence joins two complete ideas — with
  "and", a semicolon, or a trailing comma-clause — split it. (A conjunction
  inside one phrase, like "your first and last name", is fine.) Short sentences
  are the single biggest win for a struggling reader.
- **Everyday words.** Prefer the word a ten-year-old uses: "use" not "utilise",
  "start" not "commence", "before" not "prior to", "help" not "facilitate". This
  is a matter of judgement on every change — no checker enforces it.
- **Front-load the action.** Say what to do first and why second: "Type the
  listing name to confirm." — not "In order to confirm, the listing name must be
  typed."
- **Active voice, speaking to "you".** "You must accept the terms to continue."
  — not "The terms must be accepted before continuing."
- **No implementation jargon.** Words like _HMAC_, _hash_, _token_, _idempotent_
  are for code, not for operators. Name a thing by what it does ("a one-way
  code"), not how it is built. The one exception is developer-facing API
  documentation, where literal technical terms (`JSON`, an endpoint path) are
  the correct words.
- **Concise, not lossy.** Cut filler ("please note that", "in order to", "at
  this time") but never facts. A number, a limit, a deadline, or a consequence
  the reader needs always stays.

### Consistency — say the same thing the same way

The same situation must read the same way everywhere. Reach for the established
pattern rather than inventing a new phrasing:

- **Errors** state the problem, and the fix where there is one, as a full
  sentence: `"{label} is required"`, `"Password must be at least 8 characters"`,
  `"Too many login attempts. Please try again later."` A confirm-by-typing error
  is always
  `"<Thing> name does not match. Please type the exact name to
  confirm."`
- **Warnings** before a destructive action open with `Warning:` and say plainly
  and completely what will happen (see `admin.attendees.delete_warning`).
- **Success / flash messages** are short, past-tense confirmations of what just
  happened: `"Note added."`, `"Contact record saved"`.
- **Sentence case, not Title Case.** Capitalise the first word and proper nouns
  only — "Save changes", "Special instructions", "Online bookings" — for
  buttons, labels, headers, and messages alike. Some older keys are still Title
  Case; align them to sentence case when you next touch that surface.
- **End full sentences with a full stop; never a label, button, or column
  header.** A message that is a sentence gets its full stop; a fragment used as
  a control does not.

### What is checked automatically

`deno task check:copy` (run inside `deno task precommit`) scans the catalog and
fails on the **mechanical** rules a machine can judge without reading for tone:

- **Descriptive links** — never "click here" / "tap below"; the link text names
  where it goes ("View your ticket", "Read the release notes").
- **Even spacing** — no double spaces (literal `<code>`/`<pre>` examples are
  exempt).

The checker is a floor, not the whole rule. It cannot tell whether a sentence
runs too long or a word is too fancy — that judgement is yours on every copy
change, which is what the rest of this section is for.

### Before → after

| Don't                                          | Do                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| "Click here to view your ticket"               | "View your ticket"                                                                |
| "Click here if the payment window didn't open" | "Open the payment window"                                                         |
| "…keyed by its anonymised HMAC."               | "It is found by a one-way code, so the real email or phone is never stored here." |
| "For nerdy debug info click here."             | "See debug info."                                                                 |
| "In order to confirm, type the name."          | "Type the name to confirm."                                                       |

## Simplified Technical English — How We Write Documentation

Technical text follows ASD-STE100 Simplified Technical English. The reader must
understand the text the first time. This section obeys its own rules. It is the
example to copy. The quoted examples of bad writing are the one exception. Each
of them keeps the fault that it shows.

### What this covers

- Markdown in this repository: `README.md`, `AGENTS.md`, `docs/`, plans, and
  runbooks.
- Procedures, release notes, and reports.
- Pull request titles and descriptions, and commit messages.
- Text that only a developer or an operator reads: `throw new Error(...)`
  messages, log lines, and the output of `scripts/` and `cli/`.
- Code comments. The comment rules in [Preferences](#preferences) still set how
  short a comment must be.

Two kinds of writing stay outside this section:

- Everything that a person reads inside the app. That copy lives in the message
  catalog at `src/locales/en/*.json`, and
  [Simple Language](#simple-language--how-we-talk-to-users) governs it. That
  section wins for every error message, label, warning, and button in the app.
- Marketing copy and brand writing.

These rules apply to the text that you write or rewrite. When you edit a
paragraph, bring it to these rules. Do not rewrite a whole document only for its
style.

### Classify the passage first

Procedural text tells the reader what to do. Descriptive text explains how
something works. Never mix the two in one passage. A procedure that stops to
explain becomes a paragraph nobody can follow under pressure.

| Kind        | Voice         | Words per sentence | Other limits                                   |
| ----------- | ------------- | ------------------ | ---------------------------------------------- |
| Procedural  | imperative    | 20 maximum         | one instruction per sentence                   |
| Descriptive | simple tenses | 25 maximum         | one topic per paragraph, six sentences at most |

### Verbs

- Use only these verb forms:
  - the infinitive
  - the imperative
  - the simple present
  - the simple past
  - the simple future
  - the past participle as an adjective
- Do not use the present perfect. Write "completed", not "has completed".
- Do not use an "-ing" verb form. Write a new sentence in place of ", making it
  easy".
- Write in the active voice. Use the passive voice only in descriptive text, and
  only when the actor is unknown.
- Use only these modals: `can`, `will`, and `must`.
- Do not use should, would, may, might, or could. Write "must" when the thing is
  required. Delete the word when the thing is optional.

### Sentences

- Keep the grammar complete. Do not use contractions. Keep the articles.
- Keep the word "that". Write "make sure that the file exists".
- Put the condition before the command, and separate them with a comma. "If the
  test fails, read the log."
- Do not use a semicolon. Write two sentences.
- Use a vertical list for more than two items, or for more than two steps.

### Words

- One word carries one meaning through a whole document. Use "make sure that"
  for the check idea. The STE dictionary rejects check, verify, and confirm as
  verbs.
- Limit a noun chain to three words. Break a longer chain with prepositions.
  Write "the timeout value for the connection pool".
- Delete a word that carries no fact. Examples: simply, seamlessly, robust,
  powerful, comprehensive, leverage, "in order to", and "it is worth noting".
- Replace utilize with use, prior to with before, in the event that with if, and
  e.g. with "for example".
- Use British spelling. Code, identifiers, file names, and an established term
  such as the behavior contract keep their own spelling.

### Warnings

Write the command or the condition first. Write the risk second. The reader must
meet the instruction before the explanation.

> Do not run this against production. The command deletes rows.

A warning inside the app is copy, so it opens with `Warning:` instead. See
[Simple Language](#simple-language--how-we-talk-to-users).

### Never touch

- Code blocks, identifiers, CLI commands, file paths, quoted error messages, and
  product names stay exactly as they are. One of these items inside a sentence
  counts as one word toward the limit. A standalone code block or quoted line
  sits outside the sentence count.
- Facts stay as they are too. If the source names no number and no cause, keep
  the general statement. Do not invent a specific one.

### Self-check before you finish

- Scan the text for the cheap patterns first: contractions, "has been",
  "should", ", making", and semicolons.
- These patterns are a start, not the whole rule. Read the text again for every
  present perfect form, every "-ing" verb form, and every banned modal.
- Count the words in your three longest sentences. Split every sentence that is
  above its limit.
- Collapse a rotation of synonyms into the one word you chose.
- No checker enforces this section. The judgement is yours on every change.

### Before → after

| Do not                                                         | Do                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "This should be run prior to deployment."                      | "Run this before you deploy."                                             |
| "The migration has been applied, making the column available." | "The migration added the column. The column is now available."            |
| "Verify the key, then confirm the row count."                  | "Make sure that the key exists. Make sure that the row count is correct." |
| "the connection pool timeout value"                            | "the timeout value for the connection pool"                               |
| "Simply run the task; it will handle the rest."                | "Run the task. The task does the rest."                                   |

## Designing New Systems

When planning a new feature, design it to have every quality below. Each one
names reference implementations in this codebase — read the exemplar before
designing, and copy its shape rather than inventing a new one. These are the
systems we want more of.

### Schema-tized

Model the thing as data first — a typed schema plus a few functions folded over
it — and derive everything else (types, validation, rendering, routes) from that
one declaration. The philosophy is in the Preferences ("Schema over organic
structure", "Shared interfaces over branch-per-case"); these are the mechanisms
to copy:

- **A valibot schema as the single source of truth for a value type.** Declare
  once; derive the TS type, the runtime guard, and the options list:

  ```typescript
  export const ContactFieldSchema = v.picklist([
    "email",
    "phone",
    "address",
    "special_instructions",
  ]);
  export type ContactField = v.InferOutput<typeof ContactFieldSchema>;
  export const CONTACT_FIELDS = ContactFieldSchema.options;
  export const isContactField = (s: string): s is ContactField =>
    v.is(ContactFieldSchema, s);
  ```

  See `src/shared/types.ts` (six of these) and `src/shared/price-modifier.ts` (a
  whole family). For structured values, compose `v.object` schemas into a
  discriminated union with `v.variant("kind", […])` and a single `v.is` guard —
  `src/shared/bulk-email-targets.ts` is the reference.
- **Declarative tables.** `defineTable`/`defineIdTable`
  (`src/shared/db/table.ts`, `src/shared/db/define-id-table.ts`): a `columns`
  config built from the `col.*` builders (`col.boolean`, `col.encrypted`,
  `col.generated`, …) drives serialization, encryption, and the derived `Input`
  type. Never hand-write row mapping.
- **Config-driven CRUD.** `defineCrudApi` (`src/shared/rest/crud-api.ts`) turns
  one config object into the five standard admin API routes;
  `defineResource`/`defineNamedResource` (`src/shared/rest/resource.ts`) turn
  `{table, fields, toInput, validate}` into typed operations that the handlers
  in `src/shared/rest/handlers.ts` wire to HTTP.
- **Schema-driven forms.** `defineForm` + a `Field[]`
  (`src/shared/forms/definition.ts`): one field list drives the HTML rendering,
  the parsing/validation, and the `FormValuesFor<>` value types;
  `createFormRoute`/`createAuthedFormRoute` (`src/shared/app-forms.ts`) wire
  that same schema to both the GET (render) and POST (validate) handlers.
- **Form section headers are a `FormSection[]`, never a hand-rolled heading.** A
  form's grouped sections are modelled as data — a `FormSection[]` (`legend`
  - `children`) rendered by `FormSections`
    (`src/ui/templates/components/aggregate-sections.tsx`), which turns each
    entry into a legend-led `SectionFieldset`. A single section uses
    `SectionFieldset` directly. Never head a form section with an `<h3>`/`<h4>`
    — a `<legend>` is the section header, and routing every section through
    `FormSections`/ `SectionFieldset` keeps that so. The listing form
    (`listings/form-sections.tsx`) and the attendee form
    (`admin/attendee-form.tsx`) both build a `FormSection[]`; see them for
    conditional sections (`compact` drops the ones that do not apply).
- **One vocabulary for "attached to any record".** `defineRecordTarget`
  (`src/shared/db/record-target.ts`): a domain says which kinds of record it
  accepts and which two columns hold the kind and the id, and gets back the
  naming (`of("listing")(7)`), a stable `key`/`fromKey` pair, the
  `where`/`whereMany`/`whereChosenBy` clauses, the matching deletes, and an
  existence check. Notes (`src/shared/db/notes/target.ts`), image links
  (`src/shared/db/images.ts`), and site page items
  (`src/shared/site-pages/target.ts`) all use it — a fourth "attach something to
  any record" feature declares its kinds, it does not invent a fourth
  vocabulary.
- **A data table plus one fold.** `LISTING_DEFAULT_FIELDS` +
  `resolveListingDefaults` (`src/shared/listing-defaults.ts`); the admin guide's
  `GuideSection[]` + `renderGuideSections`.

If your plan contains a hand-rolled dispatcher, an ad-hoc form, bespoke CRUD
routes, or hand-written row (de)serialization, stop: there is a `define*`
factory for that already. Use it — or extend it for every caller.

### Checked forwards and backwards

A stateful lifecycle is declared as a machine, its combinations with other
machines are declared as a seam, and both declarations are checked in both
directions: forwards by tests that drive the real transitions and crash them
mid-flight, backwards by reading the stored data and proving it fits. This was
retrofitted onto the payment machines across three large PRs (#2065, #2079,
#2084); a new lifecycle declares it with its first slice, when it is cheap. The
mechanisms, each with its reference:

- **Declare the machine as data.** Nodes carrying representative states built
  through the production transitions, events, and an exhaustive moves table — a
  cell missing from the table is a declared refusal, never a fallthrough. The
  framework is `src/shared/schema-atlas/machine-spec.ts`; the machines are
  `src/shared/payment/{row,refund,review,sumup-recovery}-machine-spec.ts`, with
  whole-graph properties (all reachable, all can end, one declared
  provider-wait) in their `graph.test.ts` suites over the shared
  `#test-utils/machine-graph.ts` walker.
- **Derive, never restate.** SQL guards (`rowWorkMirrorSql`), status words,
  danger flags, and the operator map (`SCHEMA_ATLAS_MACHINES`, rendered at
  `/admin/schema`) all derive from the spec. Vocabulary lists derive from the
  machine's own types — an exhaustive mapped record keyed by the machine's union
  (`STORED_AUTHORITY_FACTS` in `src/shared/payment/joint-state.ts`) — so a grown
  or renamed state stops compiling until every consumer learns it.
- **Declare the seam.** When two machines share reality, declare the ILLEGAL
  combinations, each entry naming the invariant it breaks
  (`ILLEGAL_JOINT_STATES` in `src/shared/payment/joint-state.ts`). List only
  what is provably impossible: every crash window's intermediate state must stay
  legal, because a redelivery has to finish from it.
- **Witness every manufactured crash.** Each crash-manufacture test helper reads
  back every stored record it touched and asserts the combination is one a real
  run can produce (`expectLegalJointStates` in
  `test/test-utils/joint-state.ts`), so the whole crash suite polices the seam
  without new tests.
- **Enumerate flows × crash windows.** List every flow; every await between two
  durable writes is a window; each window gets an idempotent-redelivery proof or
  a fault-injected test. Faults are triggers at SQLite's own boundary, not stubs
  (`test/test-utils/db-fault.ts`), so the failing write rolls back exactly as
  production would.
- **Check backwards from the data.** A bounded scan reads the declared
  impossibilities back out of the live database and shows the operator every hit
  (`src/shared/db/schema-anomaly-scan.ts`, the `/admin/schema` "Live check").
  Key the scan's queries by the declaration table's own literal types, so
  declaring a new illegal combination refuses to compile until the scan knows
  how to find it.

### Pure, functional

Write the core of a feature as pure data-in/data-out functions and keep IO (DB
reads, settings, fetches) in a thin shell around it. Pure modules are trivially
unit-testable, which is what keeps 100% coverage and a 100% mutation kill rate
cheap to sustain.

- `src/shared/largest-remainder.ts` — a complete allocation algorithm with zero
  imports; the hardest logic in the money paths and the easiest to test.
- `src/shared/listing-defaults.ts` — the header states "This module is pure":
  callers fetch, it computes.
- `src/shared/ledger/project.ts` — pure projections over a slice of transfers;
  every derived total reuses the single `allBalances` fold, so no two totals can
  disagree.
- `src/shared/phone.ts`, `src/shared/countries.ts` — pure normalization, and a
  pure data table with total accessors.

Prefer the curried utilities from `#fp` over imperative loops (see
[FP Imports](#fp-imports)). When a module needs both computation and
configuration, split it the way `src/shared/dates.ts` does: the pure functions
take the timezone as an argument, and thin wrappers inject `settings.timezone` —
the pure core stays testable without a database.

### Modularised

One concept per file; one layer per directory. `REPO_STRUCTURE.md` defines where
things go (`src/features/*` routes, `src/shared/*` domain logic, `src/ui/*`
presentation). Within `shared/`, the shapes to copy:

- `src/shared/rest/` — `resource.ts` (the resource abstraction), `handlers.ts`
  (HTTP wiring), `crud-api.ts` (the JSON API): each file is one layer, named for
  its job.
- `src/shared/ledger/` — `types.ts`, `project.ts`, `account.ts`, `reconcile.ts`:
  a domain split into files you can navigate blind.
- `src/shared/db/attendees/` — `queries.ts`, `pii.ts`, `capacity.ts`,
  `stats.ts`, `delete.ts`: a big table's concerns separated instead of one
  1,500-line module.

A new system must arrive as a small directory of single-purpose files, not one
grab-bag module — and not as fragments scattered through unrelated existing
files.

### Well-named files

The filename states the concept; the concept fills the file.
`largest-remainder.ts`, `phone.ts`, `slug.ts`, `define-id-table.ts`,
`request-cache.ts`, `keyed-cache.ts` — you can guess each file's exports from
its name and vice versa. Function names carry contracts the same way: the `Raw`
suffix on `getAttendeesRaw`/`getAttendeeRaw` means "PII still encrypted —
decrypt before display", and `getUserDisplayFields` names the exact narrow
column set it selects. If you cannot name the file in a couple of words, it is
probably two concepts — split it.

### Valibot and standard libraries

Validation is valibot; collections are `@std/collections` (via `#fp`); paths,
media types, and cookies are `@std/path`, `@std/media-types`, and
`@std/http/cookie`; date/timezone math is `Temporal` (temporal-polyfill);
formatting is `Intl`. Valibot patterns to copy:

- **Branded scalar** — `src/shared/validation/email.ts`:
  `v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.brand("ValidEmail"))`.
  A `ValidEmail` can only be produced by validation, so downstream code needs no
  re-checks.
- **Coercing schema factory** — `src/shared/validation/number.ts`:
  `createIntSchema(minimum)` validates digits _before_ `v.transform(Number)`
  (closing the `parseInt("5abc")` hole); `PositiveIntSchema` and friends are its
  specializations.
- **Boundary validation** — `src/features/api/sms-webhook.ts`: `v.safeParse` an
  envelope `v.object` immediately after `JSON.parse`, 400 on failure. Validate
  at the boundary; pass typed values inward.
- **Deliberate non-use is fine when the platform is better** —
  `src/shared/validation/timestamp.ts` delegates instant validation to
  `Temporal.Instant.from` (valibot's `isoTimestamp` accepts overflow days) and
  documents why.

### Do not reinvent the wheel

Before writing an algorithm, formatter, or parser, check `deno.json` — the
answer is usually already a dependency. When the project's calling convention
differs from a library's, write a thin adapter; do not re-implement:

- `src/fp.ts` — `unique`, `uniqueBy`, `mapNotNullish`, `sumOf`, `chunk` are
  one-line curried adapters over `@std/collections`.
- `src/shared/db/table.ts` — `toCamelCase`/`toSnakeCase` delegate to valibot's
  case actions rather than bespoke regexes.
- `src/shared/timezone.ts` — all DST/offset math is `Temporal`;
  `src/shared/currency.ts` gets currency symbols and decimal places from
  `Intl.NumberFormat` instead of a hand-maintained table; `src/shared/slug.ts`
  validates with `v.slug()`.

When you genuinely must hand-roll, document the reason at the definition the way
`#fp`'s `groupBy` does (it exists because `@std/collections` lacks the ordering
guarantee its callers rely on).

### Curried helpers

Currying is the house style for both de-duplication (see
[Code Duplication](#code-duplication)) and API design: the factory takes the
configuration, the returned function takes the data.

- `makeOutcome(succeeded)` → `export const ok = makeOutcome(true)` /
  `fail = makeOutcome(false)` (`src/shared/response.ts`).
- `roleIn(levels)` → `isStaffRole`, `isDeliveryRole` (`src/shared/types.ts`) —
  predicate factories instead of near-identical functions.
- `balanceOf(account)` → `(transfers) => number` and friends
  (`src/shared/ledger/project.ts`) — curried projections that compose.
- At larger scale the same shape becomes the config-driven factories:
  `defineTable`, `defineCrudApi`, `defineForm`, and `cachedClientFactory`
  (`src/shared/payment-helpers.ts`).

### Built for cold starts

Most production requests land on a freshly booted edge isolate with a ~500ms
startup budget and a limited subrequest budget
(`scripts/bench/cold-start/bundle-load.ts` measures single-file load and
`scripts/bench/cold-start/first-request.ts` measures request round trips). The
rules, with their reference implementations:

- **Nothing heavy at module load.** Entry points only register the handler
  (`src/edge.ts`); app boot runs `once()` on the _first request_
  (`src/serve-app.ts`). Module-load work is fine only when pure and cheap (for
  example `defineTable` building its schemas once).
- **Lazy singletons via `once`/`lazyRef` from `#fp`.** The DB client (`getDb` in
  `src/shared/db/client.ts`), the dynamically imported Stripe SDK
  (`src/shared/stripe.ts`), the Liquid email engine, crypto key material — all
  first-use, never import-time.
- **Request-scoped memoization, not global state.** `requestCache`
  (`src/shared/request-cache.ts`) shares one fetch among all callers within a
  request. Any new per-request state is built on one of the three factories in
  `src/shared/request-scoped.ts` (`createScope`, `createScopedValue`,
  `createRequestScoped`) — the only module allowed to touch `AsyncLocalStorage`
  — so two concurrent requests on one isolate cannot clobber each other and a
  leaked post-request context always reads as "outside a request". Isolate-lived
  caches are best-effort and bounded (`src/shared/db/keyed-cache.ts`; the
  settings version-stamp cache in `src/shared/db/settings.ts`) — never
  authoritative for security decisions, and invalidated automatically by the
  write-sniffing db client (`src/shared/cache-registry.ts`).
- **Compile once, render many.** ICU message templates (including the
  `I18N_REPLACEMENTS` rebranding pass) compile once and cache
  (`src/shared/i18n.ts`), so rendering is a plain format call.
- **Respect the subrequest budget.** Fixed-cost designs like
  `src/shared/limits.ts` (one SELECT plus one batch regardless of batch size),
  `UPDATE … RETURNING` instead of update-then-select (`src/shared/db/table.ts`),
  and `queryBatch` for multi-read round-trips. Bunny has a hard limit of 50
  subrequests per request. One libsql `execute`, batch, transaction
  begin/statement/commit/rollback, or external fetch counts as one; statements
  inside one batch still count as one. The client guard blocks database call 51,
  but routes that also call providers or storage must target at most 40 database
  calls so those other fetches still fit.
- **Model realistic database latency.** The request benchmark uses 0, 5, 10, and
  20 ms per libsql round trip. Treat 20 ms as the expected worst case for a
  replicated database; do not publish 50 or 100 ms projections as realistic
  production measurements without evidence from production.

A new feature that adds a top-level `await`, an import-time SDK load, or a
per-request whole-table read is a cold-start regression even if it works.

### Efficient SQL

The rules live in [Database Queries](#database-queries) (narrow column lists,
bounded reads, batches vs interactive transactions). Beyond those, copy these
shapes:

- **Enforce invariants in the mutating statement itself.**
  `src/shared/db/capacity.ts` embeds the capacity check in the same
  INSERT/UPDATE that books the attendee — no read-modify-write race, no second
  round-trip.
- **Trigger-maintained aggregates instead of scans.**
  `listings.booked_quantity`/`tickets_count` are maintained by triggers on
  `listing_attendees`
  (`src/shared/db/migrations/2026-06-16_listing_aggregates.ts`), so listing
  reads never sum attendee rows.
- **One-round-trip patterns.** `UPDATE … RETURNING *` in
  `src/shared/db/table.ts`; `queryBatch`/`executeBatchWithResults` in
  `src/shared/db/client.ts`; keyset pagination for unbounded reads
  (`src/shared/db/backup.ts` with `BACKUP_PAGE_SIZE`).

### Decrypt only what you need

Encrypted data stays encrypted until the moment of display, and lookups never
require decryption:

- **Blind HMAC indexes for lookups.** Alongside each searchable encrypted value
  sits a deterministic `hmacHash` index column: `username_index`
  (`src/shared/db/users.ts`), `ticket_token_index`
  (`src/shared/crypto/hashing.ts`, `src/shared/db/attendees/queries.ts`),
  `phone_index` for inbound SMS (`src/shared/db/attendee-phone-index.ts`),
  `code_index` on modifiers. Query `WHERE …_index = ?`; never scan-and-decrypt.
  (The one sanctioned scan-decrypt — invite codes in `users.ts` — is documented
  and bounded by a tiny keyspace.)
- **One blob, one decrypt, decrypt late.** All attendee PII lives in a single
  `pii_blob` (`src/shared/db/attendees/pii.ts`); list queries select it without
  decrypting (`getAttendeesRaw` and friends in
  `src/shared/db/attendees/queries.ts`), and `decryptAttendees` runs only at
  render time. `decryptPiiBlob`'s `paidListing` flag even gates which fields
  come out of the blob, and `getAttendeeNamesByIds` decrypts just the name.
- **Skip encrypted columns entirely when you can.** `getUserAuthFieldsById`
  (`SELECT id, admin_level`) and `getAttendeeKindsByIds` (`SELECT id, kind`)
  answer their questions without touching a ciphertext — the same discipline as
  "Select only needed columns", applied to plaintext-in-memory.
- **Declarative encryption at the column layer.**
  `col.encrypted`/`col.encryptedText` in `src/shared/db/table.ts` decrypt
  lazily, per present column; a new encrypted column is declared, not
  hand-wired.
- **Keys are request-scoped and short-lived.** The session private key is
  fail-closed per request (`src/shared/session-private-key.ts`) and decrypt
  caches are TTL-bounded to seconds (`src/shared/crypto/keys.ts`).

## FP Imports

```typescript
import { compact, filter, map, pipe, reduce, unique } from "#fp";
```

### Common Patterns

```typescript
// Compose operations
const processItems = pipe(
  filter((item) => item.active),
  map((item) => item.name),
  unique,
);

// Instead of forEach, use for...of or curried filter/map
for (const item of items) {
  // ...
}

// Instead of array spread in reduce, use reduce with mutation
const result = reduce((acc, item) => {
  acc.push(item.value);
  return acc;
}, [])(items);
```

### Available FP Functions

These are the curried helpers actually exported from `#fp`. Several are thin
adapters over `@std/collections` (noted below) so the standard library does the
work while the project keeps its pipe-friendly calling convention. For
collection operations not covered here (partitioning, keying, picking object
keys, etc.), reach for `@std/collections` directly rather than hand-rolling —
wrap it in a curried `#fp` adapter if it will be reused across the `pipe`-based
code. Note `@std/collections` has **no** `groupBy` export (it was removed in
favour of the runtime built-ins) — use native `Object.groupBy` / `Map.groupBy`
for grouping.

| Function            | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `pipe(...fns)`      | Compose functions left-to-right                   |
| `filter(pred)`      | Curried array filter                              |
| `map(fn)`           | Curried array map                                 |
| `flatMap(fn)`       | Curried array flatMap                             |
| `mapNotNullish(fn)` | Map, dropping nullish results (std mapNotNullish) |
| `reduce(fn, init)`  | Curried array reduce                              |
| `sort(cmp)`         | Non-mutating sort                                 |
| `unique(arr)`       | Remove duplicates (std distinct)                  |
| `uniqueBy(fn)`      | Dedupe by key (std distinctBy)                    |
| `compact(arr)`      | Remove null/undefined                             |
| `chunk(size)`       | Split array into chunks (std chunk)               |
| `sumOf(selector)`   | Sum by selector (std sumOf)                       |
| `sum(arr)`          | Sum an array of numbers                           |

## Code Duplication

`deno task cpd` (run as part of `deno task precommit`) runs jscpd with a **0%
threshold — this is non-negotiable**. When it fails it prints this same
guidance. Fix the duplication; do not silence it:

1. **Write a helper.** This is the answer in ~99.999% of cases. If an obvious
   shared function jumps out, extract it and call it from both sites.
2. **No obvious helper? Curry.** Lift the parts that differ into arguments of a
   function that returns the specialised version, then call it at each site.
   **Then review your work before committing — zoom out one step further.** The
   first small curry you reach for is often not the best one; a larger, more
   holistic curry across the call sites is very frequently far better.
3. **`jscpd:ignore` is the last resort.** It is excusable for basically _one_
   thing: **import blocks** (plus the rare unavoidable scrap of
   boilerplate/infrastructure we have no control over). If the duplicated code
   is not an import block, you almost certainly want option 1 or 2 — an
   `jscpd:ignore` tag anywhere else is a code smell, not a fix.

**The jscpd warning is a positive signal, not a nuisance to silence.** Each
duplication it flags is a pointer at two things that must become one — a real
merge waiting to happen, and the whole point of this exercise. So:

- **Never work around the warning by changing a structure so the matcher stops
  matching.** Swapping positional params for a config object, renaming to a
  namespace import, reordering fields, lifting a line to a named const — any
  edit whose _purpose_ is to break the token match while leaving two parallel
  implementations in place is the opposite of what we want. It hides the signal
  and keeps the duplication. If you find yourself asking "how do I make jscpd
  stop flagging this," you are on the wrong track: the question is "how do I
  make these two things one thing."
- **Every merge is warranted — the merges are the goal.** When jscpd flags a new
  helper against an existing one (as it will the moment you extract something),
  that is not a problem to route around; it is telling you the new helper and
  the old one are the same operation and must be unified into a single
  mechanism. Do that unification. Reducing the codebase to one shared way of
  doing each thing is the aim; the warning is just the to-do list.
- **After a dedup, zoom out and integrate further.** Once your new helper
  exists, search the codebase for the _other_ places that can now fold into it
  or into an existing sibling. A dedup pass rarely ends at the sites that first
  tripped the check — the biggest wins come from noticing that the helper you
  just wrote subsumes three more call sites, or that it and an older helper are
  the same thing wearing two names. Keep pulling the thread until the merges are
  genuinely exhausted.
- **A curry almost always exists — "these two cannot be merged" is nearly always
  wrong.** Two functions that differ only in a value, a path, a field name, a
  message, or a callback are one function that has not been given its parameter
  yet. Lift what differs into a factory's argument and let the returned function
  take the data. This holds even when the two bodies look nothing alike at a
  glance, because the shared part is often a _tail_ ("…and then keep what they
  were told") or an _opening_ ("open this page, and then…"), and a curry takes
  either. So treat every flagged pair as mergeable until you have actually
  written the curry and found what the parameter would have to be. "This pair is
  noise" is a conclusion you earn by trying, never a first reading — and if you
  reach for that phrase about a whole band of results, you are almost certainly
  looking at a factory nobody has written yet.

  Before you write one, look for the factory that already exists. An
  under-adopted curry reads exactly like unavoidable duplication: the pairs pile
  up at the call sites that never adopted it, so the check looks like it is
  flagging noise when it is really flagging the gap. The Cucumber page openers
  are the reference. `opensAdminPageAt(path)` in `test/specs/support/browser.ts`
  turns any "open this one fixed admin page" wrapper into a single line, and
  four support files hand-rolled the wrapper anyway.
- **The one honest exception is a shared _signature_ with nothing behind it.**
  When two functions match only on their parameter list and return type, and
  share no call at all, there is nothing to lift and a curry cannot help. Give
  that signature a named type instead and let both sides declare it —
  `ActOnOneThing` in `test/specs/support/world.ts` is the house example. Be
  strict about which case you are in: if the two bodies call even one function
  in common, you are in the curry case, not this one.

### The four scans, and how hard each looks

The 0% threshold is not the number that decides how hard jscpd looks.
`minTokens` is: it sets the shortest run of tokens that counts as a clone, so a
lower number is a tighter net. Four configs divide the tree, because helper code
and test bodies deserve different nets.

| Config                | Scans                            | minTokens |
| --------------------- | -------------------------------- | --------- |
| `.jscpd.json`         | `src`, `e2e-payments`, `scripts` | 19        |
| `.jscpd.specs.json`   | `src` + `test/specs/support`     | 19        |
| `.jscpd.helpers.json` | `src` + `test/test-utils`        | 40        |
| `.jscpd.test.json`    | `test`                           | 48        |

Both helper trees are scanned **alongside `src/`**, so a helper that
reimplements production logic is flagged against the source it copied. A
separate run could never see that pair. A test body is different: it repeats by
design, and the shared mechanism is the test framework itself, so the whole of
`test/` stays at the loose 48.

**Every helper number ratchets downward** — lower it, bring the tree to it,
repeat — the same way `check:comments` works. `docs/test-duplication.md`
measures what each remaining step costs. Read its counts as work to do, not as a
floor: the counts fall as the curries land.

## Database Queries

Avoid `SELECT *`, and avoid loading more rows or columns than the caller needs.

- **Prefer explicit, narrow column lists.** Write
  `SELECT id, name, admin_level FROM …`, never `SELECT *` — list only the
  columns the caller reads. This keeps less plaintext/PII in memory, skips
  decrypting columns nobody uses, and makes each query's data dependencies
  obvious. Copy the existing examples: `getUserDisplayFields`
  (`id, username_hash, admin_level`), `getAllUserIds` (`id`),
  `getAllAttendeePiiBlobs` (`pii_blob`), `getAllRawEmailTemplates`
  (`id, subject, body`).
- **"Get all rows" is rarely the right shape.** About the only legitimate reason
  to read a whole table is rendering an admin collection page (for example
  `/admin/listings`, `/admin/questions`) — and even then, select only the
  columns those rows display, not every column on the table. Everything else
  must be a bounded query (by id, by key, or with a `WHERE`/`LIMIT`).

Some reads legitimately need the full row — these are the exceptions, not the
rule:

- **An entity cache that also backs single-record reads.** When one
  request-scoped cache serves both the collection view and the
  `getById`/`getByKey` detail/auth reads (listings, users, groups, holidays,
  built-sites, attendee-statuses), it loads the full entity once so the detail,
  edit, and login paths it feeds have every column. Narrowing the cache load
  would break those reads. (`getAllListings`' `SELECT listing.*` is deliberately
  wide — it also carries the trigger-maintained
  `booked_quantity`/`income`/`tickets_count` aggregate columns.)
- **Full-table backup/restore** (`backup.ts`) — a dump needs every column to
  round-trip.
- **A table's whole-row read** (`table.read.one`/`read.many` with no columns
  named, in `table-reader.ts`) — it selects every stored column by design and
  feeds edit pages that need the whole row; a read that wants less names its
  columns with `read.pick`, and specific tables narrow at the cache `fetchAll`
  layer instead.

Outside these documented full-row exceptions, a caller that genuinely needs many
columns must still list them explicitly rather than `SELECT *`. A column added
later then does not silently widen every read.

### Transactions and Batches

For anything more complex than a single statement, prefer libsql's batches or
interactive transactions over firing independent `execute` calls. Independent
calls neither share a transaction (a later failure cannot undo an earlier write)
nor a round-trip (each one is a separate request to the primary). The helpers in
`src/shared/db/client.ts` already wrap libsql's transaction APIs — reach for
them rather than calling `getDb().batch`/`getDb().transaction` directly, so
query logging and table-scoped cache invalidation stay automatic.

- **Batch — multiple statements, no logic between them.** When you know all the
  statements up front and none depends on the result of an earlier one, use a
  batch. It runs them sequentially in one implicit transaction over a single
  round-trip: success commits everything, any failure rolls the whole thing
  back. Use `executeBatch` (writes, discards results), `executeBatchWithResults`
  (writes, returns each `ResultSet` — ideal for cascading deletes and multi-step
  writes), `queryBatch` (reads in one round-trip), or `queryBatchPrimary` (reads
  pinned to the primary when you must read your own just-committed writes).
  `deleteByFieldBatch` is a ready-made multi-table delete. One statement is not
  a batch: for a single read pinned to the primary, use `queryAllPrimary` for
  its rows or `queryOnePrimary` for the first one, never a batch of one.

- **Interactive transaction — logic between steps.** When a later statement
  depends on the result of an earlier one, use `withTransaction`. One example is
  read a balance, validate it, then conditionally update. Another is create →
  check capacity → finalize, where a zero-row guard must abort and undo
  everything. It hands your callback a `TxScope` whose `execute` runs inside one
  interactive write transaction. The transaction commits on success. On any
  error it rolls back, then rethrows. The write lock is acquired with a short
  retry so concurrent writers serialize rather than fail. A database that stays
  locked surfaces as `DatabaseBusyError`. Read-only statements and batches also
  retry fleeting upstream HTTP errors (BunnyDB 421 and Turso 502/503/504).
  Interactive transactions and write paths retry only `SQLITE_BUSY`. A write
  path never replays an upstream HTTP error, because the write can commit before
  the response arrives. Note the trade-off: an interactive transaction locks the
  database for writing until it commits or rolls back (with a timeout), so keep
  the work inside it tight — do any expensive non-DB computation before opening
  it, and prefer a plain batch whenever no inter-step logic is actually needed.

## Scripts

- `deno task start` - Run the server
- `deno task dev` - Run the server with `--watch`, restarting it whenever a
  source file changes. `build:static` runs once at the start, so an edit to a
  static asset still needs the task restarted. The dev database is the
  gitignored `local.db` at the repo root (its key lives beside it in `.db-key`),
  so data survives restarts; delete both files to start fresh. `:memory:` is not
  a valid dev URL — interactive transactions open a second connection, and each
  in-memory connection is its own empty database
- `deno task serve` - The bare server command that `start` and `dev` both call,
  so the permissions and entry point live in one place. `dev` sets
  `SERVE_WATCH=--watch` to add the watcher. Prefer `start` or `dev`, which build
  the static assets first
- `deno task test` - Run the full suite
- `deno task test:coverage` - Run the full suite with coverage
- `deno task test:files <file>...` - Run only the given test files with the same
  setup as the full runner (makes sure the static assets are current, starts
  stripe-mock, cleans up after)
- `deno task test:screenshot-contract` - Run the real-browser screenshot timing
  and responsive-layout contracts (requires Chromium)
- `deno task specs` - Run every Cucumber Feature through the shared test harness
  and write ignored Messages, HTML, and JUnit reports under `reports/`
- `deno task specs:evidence` - Run only cases with declared screenshot captures,
  one at a time, and write the versioned manifest plus PNG assets under
  `reports/evidence/`; the task requires a clean Git worktree so the manifest
  commit matches the captured code
- `deno task specs:check` - Parse every Feature and validate the strict authored
  profile and stable catalog
- `deno task specs:files <feature>... [--tags <expression>]` - Run selected
  Features through the shared harness
- `deno task lint` - Format Markdown with Deno, then format and lint code with
  Biome (`check --write`; auto-fixes in place). **Format through this task
  rather than reaching for a formatter yourself.** The two own different file
  types and neither refuses work outside its own, so `deno fmt` pointed at a
  directory of TypeScript quietly reformats every file it finds to a style Biome
  does not use — an enormous unrelated diff that buries the change you meant to
  make. Naming one file directly is fine when you know whose it is: `deno fmt`
  for Markdown, Biome for code. When in doubt, run the task.
- `deno task lint:ci` - Strict, read-only formatting and lint. Runs
  `deno fmt --check` for Markdown and Biome `check --error-on-warnings` for
  code. Fails on lint warnings (for example cognitive complexity) and on any
  file that would be reformatted, without touching the checkout. This is the
  lint `deno task precommit` runs in **every** environment, so a clean
  `precommit` locally means the lint step will pass in CI too. Run
  `deno task lint` to auto-fix before re-running.
- `deno task build:edge` - Build for Bunny Edge deployment
- `deno task backup` - Dump the database out-of-band to a `.zip`. Uploads to the
  configured storage zone by default (so it appears on the Backups page and lets
  the next migration skip its own inline backup); pass `--out <path>` to write a
  local file. Runs in a full Deno process, so unlike the in-edge backup it has
  no per-request subrequest budget and can dump arbitrarily large databases.
- `deno task restore <backup.zip>` - Restore the database named by `DB_URL` /
  `DB_TOKEN` in `.env` using its `DB_ENCRYPTION_KEY`. Shows the backup details,
  asks for typed confirmation, and reports each restore step in the console.
- `deno task snapshot --out <path.sqlite>` - Sync the complete remote database
  to a standalone local SQLite file. The task prefers `DB_URL` and `DB_TOKEN`
  from `.env` over shell values. This developer-only task checkpoints and
  verifies the file, refuses to overwrite an existing path, and removes its
  temporary replica on success or failure.
- `deno task migrate:turso` - Interactively copy a remote libSQL database into a
  new Turso database through Turso's native SQLite file upload. The task asks
  for source credentials and the destination name, uses `TURSO_API_TOKEN`,
  `TURSO_ORGANIZATION`, and `TURSO_GROUP` from `.env` when available, checks
  that the destination is free before downloading, and removes an incomplete
  destination after a failed upload.
- `deno task migrate:sites` - Interactive menu for moving built sites off Bunny
  databases. Reads the live master site's `POST /instance/site-credentials`
  endpoint to list every built site and which company runs its database,
  migrates the chosen site to a new Turso database through a temporary SQLite
  file, then sets that site's `DB_URL` and `DB_TOKEN` secrets through the Bunny
  API so it uses the new database. Reads `MAIN_INSTANCE_URL`,
  `MAIN_INSTANCE_KEY`, `BUNNY_API_KEY`, `TURSO_API_TOKEN`, `TURSO_ORGANIZATION`,
  and `TURSO_GROUP` from `.env` when set, and asks for anything missing. It
  confirms by typed site name before changing anything, and prints the new
  `DB_URL`/`DB_TOKEN` so they can be set by hand if the secret update fails. The
  site keeps its existing `DB_ENCRYPTION_KEY`.
- `deno task precommit` - Run all checks (typecheck, lint, tests)
- `deno task precommit:mutation` - The precommit mutation gate, runnable on its
  own: mutation-test every `src/` file this branch changed and demand a 100%
  kill rate. All of a source's mirror-located direct tests run first, whether or
  not those tests changed; changed tests under `test/integration/`, `test/e2e/`,
  or `specs/` run only for direct-test survivors. A changed Cucumber step or
  support file selects every Feature. The changed set is the branch's committed
  diff against the integration branch (`origin/main`, else a local `main`) via
  `base...HEAD` — three-dot/merge-base, so it is the branch's full diff vs main
  and stays bounded to the branch's own commits (precommit runs post-commit on a
  clean tree, so the index is empty). Skips cheaply when there is no base ref or
  no changed `src/` files. If a badly stale local `origin/main` balloons the
  changed set past `STALE_BASE_SOURCE_LIMIT`, it skips with a "run
  `git fetch origin main`" hint instead of mutating most of the tree. See
  [Mutation Testing](#mutation-testing).
- `deno task mutation <source-glob> <test-glob>` - Mutation-test your tests on
  demand in an isolated `.mutation-runs/<id>/work` copy: mutate operators in the
  source and check your tests catch it (see
  [Mutation Testing](#mutation-testing))

### Running Individual Test Files

**Do NOT use `deno task test -- --filter`** to debug a specific test — it still
loads the entire test suite and is very slow.

Instead, use `deno task test:files`, which runs only the files you pass but
reuses the full runner's setup — it makes sure the static client assets the app
reads at import time are current, and starts stripe-mock with
`STRIPE_MOCK_HOST/PORT` exported. This means a fresh checkout can run a subset
of the suite without manual preparation.

Both runners _skip_ the asset build when nothing it depends on has changed.
After a build they record every file it read and wrote in
`.static-assets-cache.json`, each one as a hash of its contents, and the next
run hashes them again: if every file is byte-for-byte what it was, the assets on
disk are already correct and esbuild and sass are never even loaded. That is
about 0.8s off every run, so the built assets are now left in the tree
afterwards (they are gitignored build output, and keeping them is what makes the
next run fast). _Change_ any client source, stylesheet, `deno.json`, or
`deno.lock` — or delete one of the built files — and the next run rebuilds.
Re-saving a file without changing its contents does not: the bytes decide, not
the timestamp.

```bash
deno task test:files test/shared/dates.test.ts
```

Arguments are forwarded verbatim to `deno test`, so multiple files, directories,
and flags such as `--filter` all work:

```bash
deno task test:files test/shared/dates.test.ts --filter "formats date"
deno task test:files test/integration/server-balance-webhook.test.ts test/integration/server/webhooks/*.test.ts
deno task test:files specs/payments/capacity-after-payment.feature
deno task test:files test/shared/payments.test.ts specs/payments/capacity-after-payment.feature
```

#### Lower-level alternative

For a pure unit test that imports neither the app nor Stripe, you can skip the
harness and run `deno test` directly on the file (fastest, but it fails on a
missing `src/ui/static/*.js` asset or an unstarted stripe-mock if the test does
import them):

```bash
deno test --no-check --allow-all test/shared/dates.test.ts
```

To do this for a test that depends on stripe-mock (anything importing Stripe),
start the mock first (`deno task test:files` or `deno task test` does this for
you, or run `.bin/stripe-mock -http-port 12111` manually) and set the env vars
to the port you chose:

```bash
STRIPE_MOCK_HOST=localhost STRIPE_MOCK_PORT=12111 deno test --no-check --allow-all test/scripts/stripe-mock/ports.test.ts
```

## Environment Variables

Environment variables are configured as **Bunny native secrets** in the Bunny
Edge Scripting dashboard. They are read at runtime via `process.env`.

The optional static CDN is different: `CDN_URL`, `CDN_BUNNY_STORAGE_ZONE_NAME`,
`CDN_BUNNY_STORAGE_ZONE_KEY`, `CDN_BUNNY_STORAGE_HOST`, and
`CDN_BUNNY_PULL_ZONE_ID` are GitHub repository secrets used only while building.
When all five are set, the build uploads site-independent browser assets and
image-codec WASM under an immutable content-addressed path, purges the pull zone
with the existing `BUNNY_ACCESS_KEY` repository secret, verifies every public
object byte-for-byte, then bakes those public URLs and their CSP origin into the
edge script. They must not be added to the running Bunny script. With all five
absent, assets stay embedded; a partial set fails the build. Site-bound assets
such as `embed.js` and the dynamic `/order.js` body remain in each script. Use
the Storage API hostname shown on Bunny's Storage **Access** page for
`CDN_BUNNY_STORAGE_HOST` (for example, `storage.bunnycdn.com` or
`uk.storage.bunnycdn.com`).

### Required (configure in Bunny dashboard)

- `DB_URL` - Database URL (required, for example `libsql://your-db.turso.io`)
- `DB_TOKEN` - Database auth token (required for remote databases)
- `DB_ENCRYPTION_KEY` - 32-byte base64-encoded encryption key (required)

### Optional

- `PORT` - Server port (defaults to 3000, local dev only)
- `BUNNY_API_KEY` - Bunny API key (required for custom domain management, with
  `BUNNY_SCRIPT_ID`)
- `BUNNY_SCRIPT_ID` - Bunny Edge Script ID (required for custom domain
  management, with `BUNNY_API_KEY`)
- `STORAGE_ZONE_NAME` - Bunny CDN storage zone name (required for image uploads)
- `STORAGE_ZONE_KEY` - Bunny CDN storage zone access key (required for image
  uploads)
- `BACKUP_PAGE_SIZE` - Rows read per keyset page when dumping a table for backup
  (default 500). Each page is one libsql response, so this bounds the response
  size to stay under libsqld's "Response is too large" payload cap. Used by
  `deno task backup` and the admin Backups page; migrations no longer back up
  inline (the edge subrequest budget cannot fit a full dump), so backups are
  taken out-of-band.
- `MAIN_INSTANCE_KEY` - Shared secret authorizing the inter-instance
  site-credentials endpoint (`POST /instance/site-credentials`). When set on a
  builder/main instance, that endpoint returns built sites' DB URL + token to a
  caller presenting this key as a bearer token, so the upgrade workflow can back
  each site up to the builder's storage before deploying. The returned token is
  each site's own full-access credential (the same one the site runs with) —
  callers only read, but must treat the response as write-capable production
  secrets. The caller passes the release tier it is publishing as
  `?tier=alpha|beta|release` (a tier-less call defaults to `release` ⇒ the whole
  fleet, which is what the single-site `backup-site` action relies on); each
  site carries an `updates` channel and only the sites at that tier or more
  eager are returned (a `release` deploy reaches every site, `beta` reaches
  beta + alpha sites, `alpha` only alpha sites — an unknown tier is a 400). The
  response echoes the applied `tier` so a caller can confirm the server actually
  filtered: a pre-tier build ignores the query string and omits it, letting the
  canary workflow fail closed instead of fanning a non-release deploy out to the
  whole fleet. Unset `MAIN_INSTANCE_KEY` ⇒ the endpoint is disabled (404). The
  upgrade workflow receives the key as a run-time input, not a stored GitHub
  secret.
- `DENO_DEPLOY_TOKEN` - Deno Deploy organization access token. Required with
  `DENO_DEPLOY_ORG_ID` and `DENO_DEPLOY_ORG_SLUG` to build sites on Deno Deploy.
- `DENO_DEPLOY_ORG_ID` - Deno Deploy organization ID used by the app creation
  API.
- `DENO_DEPLOY_ORG_SLUG` - Deno Deploy organization slug used in each app's
  managed `<app>.<organization>.deno.net` production domain.
- `BUNNY_DNS_ZONE_ID` - Bunny DNS zone ID for subdomain registration (enables
  subdomain feature when set with `BUNNY_API_KEY`)
- `BUNNY_DNS_SUBDOMAIN_SUFFIX` - Suffix appended to user-chosen subdomain (for
  example `.tickets`)
- `NTFY_URL` - Ntfy endpoint URL for error notifications (for example
  `https://ntfy.sh/your-topic`). Sends domain and error code only, no personal
  or encrypted data.
- `SENTRY_URL` - Sentry DSN for server-side error reporting (for example a
  self-hosted Bugsink: `https://<key>@bugs.example.com/<project>`). When set,
  the same classified server errors that log to the console and ping ntfy are
  also captured by Sentry, with a real stack trace when the originating
  exception is available. Unset ⇒ Sentry is disabled (the SDK never
  initializes). The release is `chobble-tickets@<commit>`, matching the source
  maps the deploy workflows upload; readable (un-minified) traces additionally
  require the `SENTRY_AUTH_TOKEN`, `SENTRY_CLI_URL` (the instance base URL, for
  example `https://bugs.example.com/`), `SENTRY_ORG`, and `SENTRY_PROJECT`
  GitHub Actions secrets so the deploy can inject debug IDs and upload the maps.
  Without those secrets the deploy still works; traces just stay minified.
- `UPTIME_KUMA_URL` - Uptime Kuma 2.4 or newer base URL used by builder
  instances to inspect and add built-site scheduled maintenance monitors.
  Requires `CAN_BUILD_SITES=true`, `UPTIME_KUMA_USERNAME`, and
  `UPTIME_KUMA_PASSWORD`.
- `UPTIME_KUMA_USERNAME` - Uptime Kuma username. Must be set with
  `UPTIME_KUMA_URL` and `UPTIME_KUMA_PASSWORD`.
- `UPTIME_KUMA_PASSWORD` - Uptime Kuma password. Must be set with
  `UPTIME_KUMA_URL` and `UPTIME_KUMA_USERNAME`.
- `UPTIME_KUMA_INTERVAL_MINUTES` - Optional positive whole number controlling
  how often new built-site monitors run. Defaults to `15`.
- `DEBUG_KEY` - Optional diagnostic key. `GET /health` returns a plain `Up :)`
  by default; a request with a matching `X-Debug-Key` header instead returns
  JSON build diagnostics (commit, build timestamp, server time) — non-private
  but useful to operators. Unset ⇒ verbose health disabled. The running build
  also records its commit into `settings.current_script_commit` on boot, so a
  backup carries the commit the site was on and a restore can surface which
  commit to redeploy (via `.github/workflows/restore-deploy.yml`).
- `BOTPOISON_PUBLIC_KEY` - Optional Botpoison public key (sent to the browser).
  The contact form works without it; setting it together with
  `BOTPOISON_SECRET_KEY` adds proof-of-work spam protection as a progressive
  enhancement. The owner still enables the form under Site → Contact and sets a
  business email.
- `BOTPOISON_SECRET_KEY` - Optional Botpoison secret key. Used server-side to
  verify contact form submissions when Botpoison is enabled. Never sent to the
  browser.
- `ADMIN_EMAIL_ADDRESS` - Enables a superuser recovery option in owner settings.
  The local-part (before `@`) must be a valid app username (2–32 characters,
  letters, numbers, hyphens, underscores). Email delivery must be configured
  before the superuser can be enabled. Also enables the owner-only **Support**
  page (`/admin/support`), where the operator can message this address.
- `SUPPORT_PAGE_TEXT` - Optional markdown shown at the top of the Support page
  (requires `ADMIN_EMAIL_ADDRESS`). Use literal `\n` for line breaks since Bunny
  secrets cannot hold real newlines. When unset, a placeholder note is shown
  instead. The support form below it (which delivers to `ADMIN_EMAIL_ADDRESS`)
  needs a business email to be set, like the public contact form.
- `SUPPORT_FORM_NAG_DAYS` - Optional positive integer (default `7`). For this
  many days after a support-form submission, the Support page shows a "you last
  submitted this form …" notice to discourage duplicate messages.
- `I18N_REPLACEMENTS` - Optional comma-separated `from|to` substring
  replacements that rebrand the **translatable copy** of every rendered message,
  for example `ticket|booking,attendee|guest`. Matching is case-insensitive and
  by substring (`ticket|booking` turns `tickets` into `bookings`), and the
  output copies the source word's capitalisation — `Ticket` → `Booking`,
  `ticket` → `booking` (only lowercase and title-case occur in real copy). It is
  applied to each message **template** once at load, and the rebranded template
  is compiled and cached, so rendering stays a plain ICU format with no per-call
  cost (important on a cold-booting edge runtime). It deliberately leaves alone:
  HTML tags and attributes (so link `href`s survive), `<code>` examples (literal
  route/CLI text), interpolated values such as a stored listing name (so "type
  this exact name" confirmations still match), and the fallback key returned for
  a missing translation. Avoid terms that collide with ICU keywords or
  placeholder names (`name`, `count`, `plural`, …).
- `APPLE_WALLET_PASS_TYPE_ID` - Apple Wallet Pass Type ID (for example
  `pass.com.example.tickets`)
- `APPLE_WALLET_TEAM_ID` - Apple Developer Team ID (for example `ABC1234567`)
- `APPLE_WALLET_SIGNING_CERT` - PEM-encoded signing certificate
- `APPLE_WALLET_SIGNING_KEY` - PEM-encoded signing private key
- `APPLE_WALLET_WWDR_CERT` - PEM-encoded Apple WWDR intermediate certificate

Apple Wallet can be configured via env vars (all 5 required) or via the admin
settings page. Admin settings (encrypted) take priority over env vars. If
neither is configured, the feature is disabled.

### Stripe Configuration

Stripe is configured via the admin settings page (`/admin/settings`), not
environment variables:

- Enter your Stripe secret key in the admin settings
- The webhook endpoint is automatically created in your Stripe account
- The webhook signing secret is stored encrypted in the database

Admin password and currency code are set through the web-based setup page at
`/setup/` and stored encrypted in the database.

## Deno Configuration

The project uses `deno.json` for configuration:

- Import maps for `#` prefixed aliases
- npm packages via `npm:` specifier
- JSR packages via `jsr:` specifier

## Test Framework

Tests use Deno standard library packages directly:

- `@std/testing/bdd` — `describe`, `it` (aliased as `test`), `beforeEach`,
  `afterEach`
- `@std/expect` — `expect()` assertions
- `@std/testing/mock` — `spy()`, `stub()` for mocking
- `@std/expect/fn` — `fn()` for mock functions
- `@std/testing/time` — `FakeTime` for timer tests

### Cucumber Acceptance Specifications

Cucumber owns user journeys and observable business rules; direct Deno tests own
pure logic, technical contracts, and everything a story cannot prove. A Cucumber
journey never supplies the only coverage of a production line or branch.

**See [E2E_TESTS.md](E2E_TESTS.md)** for the full rules: the three test
categories, the authored Feature hierarchy and tags, how specs are run, the
checklist for migrating an existing test into a story, and the pitfalls that
have caught people out before.

One rule from that checklist is repeated here, because it is the rule that
people skip, and a skipped check lost real coverage more than once. **A test
that moves into a story is a replacement, so prove that it replaced everything.
Build the list of the old test's claims from the diff, never from the new
file.** Name the merge base once with `base=$(git merge-base origin/main HEAD)`.
Read `git diff "$base" HEAD` and `git show "$base":<file>` from that one commit,
never from main's tip. A finished story feels like a check of the work, but it
is not one. A good story reads as though it covers everything, so only the old
file says what is missing. This applies to a file that you rewrote in place as
much as to one that you deleted, and the rewrites are where the real losses
occurred. Every claim then lands in one of three places: in the story, in a
direct test that you keep, or in a drop that you state out loud.

## Test Quality Standards

All tests must meet these mandatory criteria:

### 1. Tests Production Code, Not Reimplementations

- Import and call actual production functions
- Never copy-paste or reimplement production logic in tests
- Import constants from production code, do not hardcode

### 2. Not Tautological

- Never assert a value you just set (for example, `expect(true).toBe(true)`)
- Always have production code execution between setup and assertion
- Verify behavior, not that JavaScript assignment works

### 3. Tests Behavior, Not Implementation Details

- Verify observable outcomes (HTTP status, content, state changes)
- Refactoring must not break tests unless the behavior changes
- Answer "does it work?" not "is it structured this way?"

### 4. Has Clear Failure Semantics

- Test names describe the specific behavior being verified
- When a test fails, it must be obvious what broke
- Use descriptive assertion messages

### 5. Isolated and Repeatable

- Tests clean up after themselves (use `beforeEach`/`afterEach`)
- Tests do not depend on other tests running first
- No time-dependent flakiness

### 6. Tests One Thing

- Each test has a single reason to fail
- If you need "and" in the description, split the test

### 7. Assertion Strength and Mutation Resistance

- Treat 100% coverage as a hygiene floor, not proof that tests would catch
  meaningful regressions.
- Prefer assertions that fail under realistic mutants: wrong
  arithmetic/operator, skipped validation, inverted permission checks, missing
  persistence, or omitted escaping.
- Avoid compound boolean assertions such as `expect(a && b).toBe(true)`; assert
  the observable contract directly with exact values, object shape, persisted
  rows, HTTP status/body, or rendered content.
- Avoid ending a test at `toBeTruthy()` / `toBeDefined()` unless mere existence
  is the actual user-visible contract. If existence matters, pair it with
  format, value, range, ordering, persistence, or security invariants.
- For pure functions, add table-driven or property-style examples that cover
  families of inputs and state the invariant being protected. Keep any generated
  cases deterministic.
- For critical flows, include negative-path, idempotency, concurrency, and
  metamorphic tests: for example payment/webhook replay does not double-credit,
  capacity cannot go below zero across edits/deletes, role downgrades remove
  access, and PII/secrets remain encrypted or absent from responses/logs.
- When generated or bulk-added tests are involved, run
  `deno task test:quality-audit` and review assertionless, truthiness,
  presence-only, and compound-boolean findings before trusting the coverage
  number.

### Mutation Testing

`test:quality-audit` only _guesses_ which assertions look weak.
`deno task
mutation` **proves** it: it mutates operators in your source and
checks whether your tests fail. A mutant your tests still pass on ("survived")
is a real gap — a code change nothing would have caught.

```bash
# Mutate a module's operators and run its mapped tests
deno task mutation src/shared/dates.ts test/shared/dates.test.ts

# Globs and exhaustive mode (every operator replacement, not just one each)
deno task mutation 'src/shared/forms/definition.ts' 'test/shared/forms/definition/*.test.ts' --exhaustive
```

It reports a mutation score and lists each survivor as
`file:line:col  old → new`. Exit code is non-zero if any mutant survived, so it
can gate CI on a chosen module. By default it runs the test files directly
(fast, for pure-unit modules); pass `--harness` for tests that import the app /
Stripe and need built static assets + stripe-mock. Under `--harness`, mutating a
client-bundle source (anything bundled into `src/ui/static/*.js` — for example
`src/ui/client/admin.ts` or a module it imports) rebuilds just the affected
bundle for each mutant, so the mutation reaches the built asset the tests load.
Likewise, a mutant in any file that feeds the run-wide prebuilt test state (the
golden schema DB and captured setup ceremony — the import graph of
`test/test-utils/test-state.ts`, see `scripts/mutation/state-graph.ts`) runs
direct tests without the stale state. If the mutant survives, the runner builds
one fresh state from the mutant and shares it across all integration-test
batches.

How it works (and why it is bespoke): static gates apply mutants in isolated
sibling copies. Mutants that pass are written over the run's source file, tested
in a fresh `deno test` subprocess, then restored. The normal
`deno task mutation` command first copies the current checkout (including dirty
source/test edits, excluding `.git`, cache/report folders, local databases,
secrets, and generated assets) to `.mutation-runs/<id>/work`; test-stage writes
and per-mutant bundle rebuilds happen inside that copy, not the live files.
Static worker copies are deleted before tests start. A run deletes its main copy
as soon as it ends — reporting the failure if it cannot — so `.mutation-runs/`
does not fill up with checkout copies. While a run is going — and until the
_next_ run starts — it has a small `.mutation-runs/<id>/run.json` holding the
child PID/status, so a stray run is easy to find and stop. Starting a run clears
out the folders of every earlier run that is no longer going, including any
whose `run.json` is unreadable because it was killed mid-write:

```bash
deno task mutation --list
deno task mutation --kill <run-id>   # or: all
deno task mutation --clean finished  # or: <run-id> / all
```

In-place mutation inside the copied checkout is what makes mutations bind
through `#…` import-map aliases. The operator tables and AST walk are vendored
from [Mutasaurus](https://github.com/christoshrousis/mutasaurus) (MIT); its own
execution model writes a temp copy but runs the original tests, so every mutant
falsely "survives" on an alias-based project — see
`scripts/mutation/LICENSE.mutasaurus.md`. As a manual tool it is **targeted**
(run `deno task mutation` on the module you are hardening) — running it across
the whole tree would be far too slow. The standalone
`deno task precommit:mutation` runs it automatically, but **only over the files
this branch changed** (its committed diff against `origin/main`/`main`): the
`precommit:mutation` step runs each source's mirror-located direct tests first,
whether or not the direct tests changed, then runs changed `test/integration/`,
`test/e2e/`, and `specs/` files only for survivors. A changed Cucumber step or
support file selects every Feature. Tests for unchanged sources, scripts, and
test helpers are outside that src mutation run. A standalone mutation command
still rejects any explicit test that neither mirrors a selected source nor lives
in an integration folder or `specs/`. The gate demands a 100% kill rate, so the
cost stays bounded to the source files you actually changed. Run
`deno task precommit:mutation` before merging a branch that changes `src/`
files; the standard `deno task precommit` no longer runs it (it was too slow for
every commit). Known-equivalent survivors recorded in
`scripts/mutation/equivalent-mutants/` are suppressed, as with a manual run.
Never record `=== → ==`/`!== → !=` mutants: Biome's `noDoubleEquals` rule is
configured to reject loose comparisons even against `null`, and the runner
counts that lint failure as killed before tests run. Use
`deno task mutation:audit-equivalents` to check the whole equivalent list with
lint and type-check only; pass `--write` to remove entries those static gates
now kill. The audit never runs tests and refuses to rewrite stale or malformed
entries. Like `deno task mutation`, it works in a copy of the checkout under
`.mutation-runs/`, so the live source files are never left mutated and a commit
made while it runs cannot pick up a mutant. With `--write`, the pruned
`equivalent-mutants/` registry files are copied back when the run ends — unless
one was edited meanwhile, which fails the run instead of overwriting the edit.

Before it runs the mapped tests, the runner puts every mutant through two cheap
**static gates**, ordered cheapest-first: a per-file Biome **lint** and then a
`deno check` **type-check**. Static gates run concurrently in isolated sibling
copies, with a CPU-aware limit capped at four (`MUTATION_STATIC_JOBS` can lower
it). One- and two-mutant files stay serial to avoid copy overhead. Test batches
keep their separate `--jobs` limit and still run only after static results are
reported in mutant order. **No mutant is ever judged by a clock**: gates and
tests run to completion, so a mutant is killed only when a gate rejects it or a
test fails, and survives otherwise. A slow type-check or a long queue wait can
no longer be mistaken for a mutant being caught. The one clock left is
`--deadline`, a whole-run guard (default one hour) against a mutant that hangs
the tests: when it fires the run fails with no score and no summary, printing
only how far it got and where to look. It fires the same way during the
baseline, where nothing has been tested yet — a run the guard stopped is a
failure to report, never an operator's interrupt. Keep the Biome calls one-shot
unless a new benchmark proves otherwise: with pinned Biome 2.4.16, 20 warm
one-file runs measured a 17.3 ms standalone median and a 51.2 ms `--use-server`
median. Either gate exiting non-zero kills the mutant without spending a full
`deno test` on it — both a forbidden lint diagnostic and a type error are build
failures, so the mutant can never ship, and static checks are far faster than
the suite. The type-check gate catches the mutants that turn valid code into a
type error — for example a `+ → *` swap on a string concatenation (`"a" * "b"`
does not type-check), or any operator change that violates a parameter/return
type. Each gate is only trusted after the runner confirms the _unmutated_ target
passes it (the baseline probe): a standalone `deno task mutation` does not run
`lint:ci`/`typecheck` first, so if the target is not already clean the run
aborts loudly rather than scoring a bogus 100%. This means a mutant recorded in
`equivalent-mutants/` must be one that survives _both_ gates _and_ the tests; a
mutation that produces a type error never reaches the ignore-list because the
type-check gate kills it first.

When a manual mutation run (or the precommit gate) surfaces survivors on a file
you are touching — even on lines you did not change in this PR — they are yours
to fix. Never determine whether a survivor "predates main" (no `git stash`, no
diffing against the base to excuse it): the bar is 100%, and a survivor on a
line in your changed file is a real gap in that file's tests that you are now
the person best placed to close. Either write the assertion that kills it, or
record the mutant in `scripts/mutation/equivalent-mutants/` with a proof that no
input can distinguish it. "It was already there" is not a resolution; leaving it
just guarantees the next person trips over the same survivor. This is the
[Good citizen](#preferences) rule applied to mutation testing. It is a
best-effort check with two documented blind spots (see the header of
`scripts/precommit/mutation-step.ts`): it scopes to the _committed_ diff, so
uncommitted work is not checked until committed. It also diffs against your
_local_ `origin/main` and never re-fetches, so a stale local ref under a branch
built on newer main commits can leak upstream src into the set (run
`git fetch origin main` first — a branch's own author is unaffected). In each
case, reach for `deno task mutation` on the specific module.

### Coverage Requirements

100% test coverage is required to merge into main. To find which specific lines
are uncovered, run:

```bash
deno task test:coverage
```

Then check `coverage/` for detailed coverage information.

### Test Utilities

Use helpers from `#test-utils` instead of defining locally:

```typescript
import {
  createTestDb,
  mockFormRequest,
  mockRequest,
  resetDb,
} from "#test-utils";
```

### Anti-Patterns to Avoid

| Anti-Pattern                    | What To Do Instead               |
| ------------------------------- | -------------------------------- |
| `expect(true).toBe(true)`       | Assert on actual behavior/state  |
| Reimplementing production logic | Import and call production code  |
| Duplicating test helpers        | Use `#test-utils`                |
| Magic numbers/strings           | Import constants from production |
| Testing private internals       | Test public API behavior         |

### Tests That Share A Machine

A test that reserves a real resource — a port, a lock file, a fixed path —
shares it with every other suite running at that moment, and CI runs them loaded
and in parallel. The failure this produces is the nastiest kind: rare,
unreproducible locally, and landing on whichever pull request happens to be
open, so it reads as that author's bug.

`withUnusedPort` names the hazard exactly: it finds a free port and lets go of
it before the code under test binds it, so anything else starting in that window
can take it. **A test that takes a port and then asserts on what the start did
must go through `retryWhilePortTaken`**
(`test/test-utils/stripe-mock/ports.ts`), which asks again on a fresh port
instead of reading a stolen one as the answer. Both known flakes in
`lifecycle.test.ts` were a sibling case that had the guard sitting next to one
that did not.

The general rule: when a test can fail because of something outside itself,
either remove the sharing or make the test able to tell the two apart. Never
leave it to chance and a re-run — a test that is right nine times in ten is a
test nobody trusts the tenth time, which is exactly when it matters.

### Fast Tests

After every run the suite prints each test slower than 500ms
(`SLOW_TEST_THRESHOLD_MS` in `scripts/test-durations.ts`). Treat entries in that
report as regressions to fix, not ambient noise. These are the patterns that
keep tests fast — reach for them when writing the test, not after it shows up in
the report:

- **The full runner shares isolates between test files.** `deno task test` deals
  the suite's files into generated group entries (`scripts/test-groups.ts`), so
  the app module graph is evaluated once per group instead of once per file, and
  the harness prebuilds the test database state — golden schema DB plus the
  captured setup ceremony — once per run (`test/test-utils/test-state.ts`)
  instead of once per file. Two rules keep a file groupable: never register a
  _global_ BDD hook (a `beforeAll` / `afterEach` at module level, including via
  a helper function called at module level — put hooks inside your `describe`),
  and never rely on a virgin isolate (module state you switch is visible to
  files that run after you, so reset what you change — and state _other_ files
  switched can be visible to you, so pin what you assert on). A file that
  genuinely needs its own isolate carries a `// test-groups: run-alone` comment.
  `deno task
  test:files` never groups: you always debug exactly the files you
  name, one isolate each, and `TICKETS_TEST_UNGROUPED=1 deno task test` runs the
  whole suite that way to rule grouping out when chasing cross-file state.
- **Never run repo tooling as a subprocess inside a test.** jscpd, Biome, and
  typechecking are dedicated precommit/CI steps; a test that shells out to
  `deno task cpd` re-runs a minute of CPU inside every suite run to enforce a
  gate that already exists elsewhere.
- **Never sleep for real.** A test driving a retry/backoff path (the write-lock
  retry, migration verify retries — anything built on `retryWithBackoff`) wraps
  the operation in `withVirtualBackoff` from `#test-utils`, which advances a
  `FakeTime` clock timer-by-timer instead of genuinely waiting the 50/150/350ms
  backoffs out.
- **Render once, assert many.** A suite making many assertions about ONE page in
  its default fixture state uses `cachedAdminPage(path)` — the page renders a
  single time and every test asserts against the cached HTML
  (`test/integration/server/guide.test.ts` is the reference). Tests that alter
  config, env, or fixture data still fetch their own copy.
- **Seed volume with a batch, not a loop.** When a test needs many rows (for
  example filling a pagination page), create ONE record through the production
  path and clone its rows in a single batch — see `seedFillerAttendees` in
  `test/test-utils/db-helpers/attendee-seeding.ts` — instead of running the full
  production write path N times.
- **Shard inherently heavy suites.** A suite that is minutes of sequential work
  by nature (the migration restore/chain suites) is split into shard files
  driven by one factory so `deno test --parallel` spreads it across workers —
  see `test/integration/db/migration-restore/` (shard by `index % shardCount`,
  which stays balanced as the list grows).
- **Keep heavy SDKs out of module load.** Every test isolate — a group of files
  under the full runner, each named file under `test:files` — evaluates the
  whole app module graph, so an import-time SDK evaluation is paid once per
  isolate, dozens of times per run. Dynamically import heavy dependencies on
  first use; `stripe.ts` and `sentry.ts` are the references (this is the
  [cold-start rule](#built-for-cold-starts) applied to tests).
- **`expect(bigHtml).toContain(...)` is safe here** because `#test-utils`
  overrides the matcher (`test/test-utils/fast-expect.ts`): the @std/expect
  built-in pretty-prints the entire searched value even when the assertion
  passes (~35ms per call on a rendered page), the override only formats on
  failure.
