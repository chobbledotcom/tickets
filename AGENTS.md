# tickets

A minimal ticket reservation system using Bunny Edge Scripting and libsql.

## Where to find guidance

All repository guidance is in this file or in documents that it links to.

Read this file and follow its links for additional guidance. Do not search the
wider machine for instructions, plans, or approval records. If required guidance
is absent from these sources, ask the user for its location.

The proposed corrections for PR #2259 are in the
[group page and package privacy contract](docs/group-page-corrections.md).

## Getting Started

Assume the workspace is probably running on NixOS. The developer environment is
devenv (`devenv.nix`); it provides the pinned Deno and the other tools. Install
devenv once (`nix profile add nixpkgs#devenv`, or see
<https://devenv.sh/getting-started/>), then enter the shell:

```bash
devenv shell
```

For one command, run it through the shell instead of entering it:

```bash
devenv shell deno task precommit
```

A command with its own flags needs `--` before it:

```bash
devenv shell -- deno task test --filter "formats date"
```

### Automatic activation

The devenv shell hook can start this environment when you enter this directory.
Add the hook to your shell configuration first:

```bash
# bash
eval "$(devenv hook bash)"
```

```bash
# zsh
eval "$(devenv hook zsh)"
```

```fish
# fish
devenv hook fish | source
```

Fish and nushell usually need no setup. devenv installed through Nix loads their
hooks by itself.

For nushell without automatic setup, run this once inside nushell:

```nu
mkdir ($nu.default-config-dir | path join autoload)
devenv hook nu | save --force ($nu.default-config-dir | path join autoload/devenv-hook.nu)
```

Run `devenv allow` in this repository to trust it. The hook starts the shell at
the next prompt. The hook leaves the shell when you `cd` out. The hook starts it
again when you return.

Do not add a direnv `.envrc` to this repository. The shell hook is the only
automatic activation.

Every development machine runs NixOS. Do not use a host-installed `deno`
directly. All `deno ...` commands in this file assume you are already inside
`devenv shell`; non-interactive agents must prefix them with `devenv shell`.

`devenv.nix` declares the tools, profiles, and Git hook. Shell setup lives in
`scripts/devenv/`. `nix/container.nix` declares the image and uses the scripts
in `scripts/container/`.

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

`devenv.yaml` pins the `nixpkgs-deno` input that provides that version.
`enterShell` in `devenv.nix` refuses to enter when the pinned nixpkgs provides
anything else. Check the version with:

```bash
devenv shell -- deno --version
```

The other tools (Biome, Chromium, gh) come from the main pinned `nixpkgs` input.
Both `nixpkgs` and `nixpkgs-deno` are pinned to specific commits in
`devenv.yaml`, so `devenv update` alone cannot move them — edit the commit SHA
in `devenv.yaml`, then run `devenv update` to refresh `devenv.lock`. CI runs the
same devenv environment as developers, through `.github/actions/setup-devenv`.

Chromium dominates the environment's size. CI jobs that never launch a browser
(the Test, backup, docs, and deploy workflows) evaluate the environment through
its `ci` profile — `devenv --profile ci shell` — which leaves Chromium out. The
browser-driven workflows (`spec-evidence`, `payment-sandbox-e2e`, `mutation`)
use the full environment, the same one `devenv shell` gives a developer.

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

  `deno task check:comments` enforces the size half of this. Both numbers
  ratchet downward, and `docs/comment-policy.md` measures what the comments cost
  and prices each remaining step. The judgement half is still yours: no checker
  can tell whether a comment earns its place.
- **Zero code duplication**: jscpd runs at a non-negotiable 0% threshold. Fix
  duplication with a helper or currying — see
  [Code Duplication](#code-duplication). The warning is a _positive signal_
  pointing at a real merge to make; never restructure code so the matcher stops
  matching while two parallel implementations stay standing. Every merge is
  warranted; the merges are the whole goal.
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
  import the same module twice. A namespace import beside named ones is the one
  allowed pair, because it reads the whole module on purpose.
  `deno task check:imports` enforces both rules, and its findings name the
  spelling to use, so a new alias enforces itself.

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
  [Designing new systems](docs/designing-systems.md)). While you are at it, use
  the split as a chance to separate pure from non-pure code — push the
  data-in/data-out logic into its own file and keep the IO in a thin shell (see
  [Pure, functional](docs/designing-systems.md#pure-functional)). **The same
  400-line limit applies to test files**, and matters just as much: smaller,
  more specific test files let us run mutation tests far faster, because a
  source file's mutants only need to run against the narrow test file that
  covers it, not one giant suite. Biome enforces a hard 1,000-line ceiling for
  every code and test file; never add an override to let one past it. Root
  instruction files such as `AGENTS.md` are exempt because their policy must be
  available as one automatically loaded document, but their sections must still
  stay concise. (Expect a known side effect when splitting: jscpd cannot fully
  scan very large files, so a split routinely _surfaces_ duplication that was
  silently passing inside the monolith — budget for extracting helpers, not just
  moving tests.)
- **Good citizen — fix what you spot**: If you notice a bug, a coverage gap, or
  a flaky/fragile test while working — even in code you were not asked to touch
  and did not write — fix it in passing rather than stepping around it. A green
  build you helped produce is your responsibility too.
- **A written-down diagnosis is a hypothesis, not a finding**: A GitHub issue, a
  review comment, a commit message, or a code comment explaining why something
  breaks was written by someone reasoning about the code at a moment that has
  passed. Re-derive it from the current source before you fix anything, however
  confident and detailed it reads — a wrong diagnosis is more expensive than
  none, because it aims your fix at the wrong place and takes the regression
  test with it. The stripe-mock port-steal note
  (`docs/stripe-mock-port-steal.md`) is the worked example: it was a careful,
  plausible, thoroughly argued account of a race in the wrong function, and
  following it would have "fixed" code that was already correct while leaving
  the real hazard in place. When you find one wrong, correct the note in the
  same change — leaving it sends the next person down the same path.
- **A finished job closes its issue**: GitHub issues hold work that is still
  open. When you complete one, close it in the same change. The commit message
  and the pull request are the record of what you did. Never leave an issue open
  and marked "done", "fixed", or "shipped". A reader must be able to trust that
  every open issue is work somebody can still pick up. The same applies to an
  issue you did not write. When you find one the code already answers, check it
  against the current source. Then close it with a comment that names the
  answer. An issue stays open only when part of its work is still open.
  `TODO.md` was the predecessor of the issue tracker. Its entries that named
  work moved to GitHub issues; its entries that recorded a decision or a
  contract moved to `docs/`; the file is now deleted. Its old rule still holds
  for issues: close an issue when you finish it, and never leave one marked
  "done". The entry this file cites as a worked example, the stripe-mock
  port-steal note, is documentation, not a job, and lives at
  `docs/stripe-mock-port-steal.md`.
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
- **A branch fixes the defects it introduces**: A review finding about code the
  branch adds is that branch's work. Fix it in the branch, pin it with a
  regression test, and merge the branch clean. Never record it as a follow-up
  issue and merge anyway: the defect exists nowhere but the open branch, and the
  issue hands work to a future person who must rebuild the context in front of
  you now. An issue is for a defect that is already on main, or for one that is
  genuinely outside the branch's scope. If the fix would complicate the branch,
  split the branch instead of merging a known defect. In a stack, the fix
  belongs to the layer that introduces it.

  The worked example: issues #2226–#2233 were opened for review findings on PR
  #2166's own new code, and the defects they describe existed nowhere but that
  open branch. The fixes belong in the same pull request.
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
  drop it — open a GitHub issue with enough context for a future person to pick
  it up without re-reading the PR (the file/path it concerns, what the reviewer
  proposed, why it is genuinely out of scope here, and a starting point), then
  reply on the thread pointing to the issue. Scope is a real boundary, not an
  excuse to lose good ideas.
- **"Actually broken" outranks "nice in a perfect world"**: A finding, review
  comment, or idea earns a fix when it names a concrete failure — real inputs
  and state under which behaviour is wrong: money lost or double-moved, data
  corrupted, a crash, a dead or forbidden link, a permission hole. Verify the
  scenario against the real code first; verified breakage gets the complete fix
  and its regression test. Everything else — symmetry, hypothetical drift with
  no concrete trigger, restating what a pinned test already enforces, polish
  whose only effect is making the document or code "more consistent" — is
  perfect-world work: declining it with a short reason on the thread is a
  first-class outcome, and a genuinely good idea becomes a GitHub issue rather
  than queue work. This is triage for what enters the queue, never licence to do
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
- **Final check**: Run `devenv shell deno task precommit` before finishing any
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
fails on the **mechanical** rules a machine can judge: descriptive links (never
"click here" / "tap below"; the link text names where it goes) and even spacing
(no double spaces; literal `<code>`/`<pre>` examples are exempt). Each finding
names its fix. The checker is a floor, not the whole rule. It cannot tell
whether a sentence runs too long or a word is too fancy — that judgement is
yours on every copy change, which is what the rest of this section is for.

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

When planning a new feature, design it to have every quality in
[Designing new systems](docs/designing-systems.md): schema-tized, checked
forwards and backwards, pure and functional, modularised, well-named, built on
valibot and the standard libraries, curried, built for cold starts, with
efficient SQL and decrypted-late PII. Each quality names reference
implementations in this codebase. Read that document, and the exemplar it names,
before you design. Copy the exemplar's shape rather than inventing a new one.
These are the systems we want more of.

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

The curried helpers actually exported from `#fp` are documented on each
definition in `src/fp.ts`; read those before you hand-roll a collection step.
Several are thin adapters over `@std/collections`. For a collection operation
`#fp` does not cover, use `@std/collections` directly, and wrap it in a curried
`#fp` adapter once more than one caller needs it. `@std/collections` has **no**
`groupBy` export (it was removed in favour of the runtime built-ins) — use
native `Object.groupBy` / `Map.groupBy`, or `#fp`'s `groupToMap`.

## Code Duplication

`deno task cpd` (part of `deno task precommit`) runs jscpd with a **0% threshold
— this is non-negotiable**. The main scan also covers Bash (`.sh`) files under
`scripts/`. When it fails it prints the fix order itself: write a helper, else
curry, and treat a `jscpd:ignore` tag as the last resort, excusable for import
blocks and essentially nothing else.

**The warning is a positive signal, not a nuisance to silence.** Each flagged
pair is a merge waiting to happen, and the merges are the goal of the whole
exercise:

- **Never work around the warning by changing a structure so the matcher stops
  matching.** Any edit whose _purpose_ is to break the token match while leaving
  two parallel implementations in place hides the signal and keeps the
  duplication. The question is "how do I make these two things one thing."
- **Every merge is warranted — the merges are the goal.** When jscpd flags a new
  helper against an existing one (as it will the moment you extract something),
  the two are the same operation and must be unified into a single mechanism.
  Reducing the codebase to one shared way of doing each thing is the aim; the
  warning is just the to-do list.
- **After a dedup, zoom out and integrate further.** Once your new helper
  exists, search the codebase for the _other_ places that can now fold into it
  or into an existing sibling. Keep pulling the thread until the merges are
  genuinely exhausted.
- **A curry almost always exists — "these two cannot be merged" is nearly always
  wrong.** Two functions that differ only in a value, a path, a field name, a
  message, or a callback are one function that has not been given its parameter
  yet. This holds even when the two bodies look nothing alike at a glance,
  because the shared part is often a _tail_ ("…and then keep what they were
  told") or an _opening_ ("open this page, and then…"). Treat every flagged pair
  as mergeable until you have actually written the curry and found what the
  parameter would have to be. Before you write one, look for the factory that
  already exists: an under-adopted curry reads exactly like unavoidable
  duplication, and the Cucumber page openers (`opensAdminPageAt` in
  `test/specs/support/browser.ts`) are the reference.
- **The one honest exception is a shared _signature_ with nothing behind it.**
  When two functions match only on their parameter list and return type, and
  share no call at all, there is nothing to lift and a curry cannot help. Give
  that signature a named type instead and let both sides declare it —
  `ActOnOneThing` in `test/specs/support/world.ts` is the house example. Be
  strict about which case you are in: if the two bodies call even one function
  in common, you are in the curry case, not this one.

Two further scans catch what literal token matching cannot, because a rename
hides a copy from jscpd:

- `deno task check:shapes` reduces each named function's body to its _shape_ —
  every name, number and string becomes one symbol — and reports two functions
  that share one. It reports whole named functions, not token runs, so a config
  object handed to a shared factory never looks like a function body. The
  accepted list at `scripts/check-shapes/accepted/` records why each allowed
  match stands; `merges-to-make.txt` must stay empty. The list only shrinks: a
  match not on it fails the check, and an entry that matches nothing any more
  fails too. `MIN_TOKENS` in the run script ratchets downward.
- `deno task cpd:renamed` runs at a tighter token count and keeps only the pairs
  whose two sides are the same code with different words. Every kept pair must
  be merged, or carry a written reason in `scripts/cpd-renamed/allowed.json`.
  The registry only shrinks: merge a pair, delete its entry, and a new word-only
  copy anywhere fails the gate.

**Every helper number ratchets downward.** `docs/test-duplication.md` measures
what each remaining step costs. Read its counts as work to do, not as a floor:
the counts fall as the curries land.

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

- `agent-diagnose` - The Nix-built host diagnostic tool reports read-only
  process, check, and Git lock facts. Use the immutable path from OpenCode's
  global instructions. See [Precommit status records](docs/precommit-status.md).
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
- `deno task cov:files <file>... [--only <part>]` - Run only the given test
  files with the same setup as `test:files`, then print the lines and branches
  this run left uncovered. Pass `--only <part>` to limit the report to files
  whose path contains `part`. This is a fast diagnostic slice. The full
  `test:coverage` gate stays the authority.
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
- `deno task backup` - Dump the database out-of-band to a `.zip` (uploads to the
  configured storage zone by default; pass `--out <path>` for a local file).
  Runs in a full Deno process with no per-request subrequest budget, so it can
  dump arbitrarily large databases.
- `deno task restore <backup.zip>` - Restore the database named by `DB_URL` /
  `DB_TOKEN` in `.env` using its `DB_ENCRYPTION_KEY`. Asks for typed
  confirmation before changing anything.
- `deno task bugs <issue-url-or-id>` - Print one Bugsink issue and its latest
  event as JSON. `deno task bugs list` prints unresolved issues, and `--all`
  adds resolved ones. Reads `SENTRY_BASE_URL` and `SENTRY_API_KEY` from `.env`.
- `deno task snapshot --out <path.sqlite>` - Sync the complete remote database
  to a standalone local SQLite file. Checkpoints and verifies the file, refuses
  to overwrite an existing path, and removes its temporary replica after.
- `deno task migrate:turso` - Interactive copy of a remote libSQL database into
  a new Turso database, through Turso's native SQLite file upload.
- `deno task migrate:sites` - Interactive menu for moving built sites off Bunny
  databases: reads the master site's site-credentials endpoint, migrates the
  chosen site to a new Turso database, and updates its Bunny secrets. Confirms
  by typed site name before changing anything.
- `deno task check:shapes` - Report two named functions that share a shape under
  different names — the duplication jscpd cannot see (see
  [Code Duplication](#code-duplication))
- `deno task precommit` - Run all checks (typecheck, lint, tests)
- `deno task precommit:mutation` - The branch mutation gate: mutation-test every
  `src/` file this branch changed and demand a 100% kill rate. See
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
harness and run `deno test` directly on the file. This is the fastest way. It
fails on a missing `src/ui/static/*.js` asset, or on an unstarted stripe-mock,
when the test imports them.

Always keep `--preload ./test/test-utils/preload.ts`. The preload puts the
complete message catalog in the isolate. The runner tasks do this for you.
Without the preload, every `t()` call throws `Missing translation for key "…"`
for copy that is already in the catalog.

```bash
deno test --no-check --allow-all --preload ./test/test-utils/preload.ts test/shared/dates.test.ts
```

To do this for a test that depends on stripe-mock (anything importing Stripe),
start the mock first (`deno task test:files` or `deno task test` does this for
you, or run `.bin/stripe-mock -http-port 12111` manually) and set the env vars
to the port you chose:

```bash
STRIPE_MOCK_HOST=localhost STRIPE_MOCK_PORT=12111 deno test --no-check --allow-all --preload ./test/test-utils/preload.ts test/scripts/stripe-mock/ports.test.ts
```

## Environment Variables

Environment variables are configured as **Bunny native secrets** in the Bunny
Edge Scripting dashboard. They are read at runtime via `process.env`. Three are
required for every site: `DB_URL` (database URL), `DB_TOKEN` (database auth
token), and `DB_ENCRYPTION_KEY` (32-byte base64 key).

Every optional variable, the build-time static CDN set, and the Stripe / admin
password configuration notes are documented in
[Environment variables](docs/env-vars.md).

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
people skip. A skipped check lost real coverage more than once. **A test that
moves into a story is a replacement, so prove that it replaced everything. Build
the list of the old test's claims from the diff, never from the new file.** Name
the merge base and the file once, as `base` and `file`, then read
`git diff "$base" HEAD -- "$file"` and `git show "$base:$file"`. Both names stay
quoted, and neither command reads from main's tip. Audit only a file that the
base holds, which
`git diff --name-only --no-renames --diff-filter=a "$base" HEAD` lists. A file
that the change adds has no earlier claims, and `git show` exits 128 on it. A
finished story feels like a check of the work, but it is not one. A good story
reads as though it covers everything, so only the old file says what is missing.
This applies to a file that you rewrote in place as much as to one that you
deleted. The rewrites are where the real losses occurred. Every claim then lands
in one of three places. It lands in the story, in a direct test that you keep,
or in a drop that you state out loud.

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
`file:line:col  old → new`, and exits non-zero if any mutant survived. How the
runner works: its isolated checkout copy, its static gates, `--harness` mode,
the equivalent-mutants registry, and why it never judges a mutant by a clock,
are documented in [Mutation testing](docs/mutation-testing.md).

As a manual tool it is **targeted** (run `deno task mutation` on the module you
are hardening) — running it across the whole tree would be far too slow.
`deno task precommit:mutation` runs it automatically, but only over the files
this branch changed (its committed diff against `origin/main`/`main`), and
demands a 100% kill rate. Run it before merging a branch that changes `src/`
files; the standard `deno task precommit` no longer runs it (it was too slow for
every commit).

When a manual mutation run (or the precommit gate) surfaces survivors on a file
you are touching — even on lines you did not change in this PR — they are yours
to fix. Never determine whether a survivor "predates main" (no `git stash`, no
diffing against the base to excuse it): the bar is 100%, and a survivor on a
line in your changed file is a real gap in that file's tests that you are now
the person best placed to close. Either write the assertion that kills it, or
record the mutant in `scripts/mutation/equivalent-mutants/` with a proof that no
input can distinguish it. "It was already there" is not a resolution; leaving it
just guarantees the next person trips over the same survivor. This is the
[Good citizen](#preferences) rule applied to mutation testing. The gate is a
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
  cold-start rule from
  [Designing new systems](docs/designing-systems.md#built-for-cold-starts)
  applied to tests).
- **`expect(bigHtml).toContain(...)` is safe here** because `#test-utils`
  overrides the matcher (`test/test-utils/fast-expect.ts`): the @std/expect
  built-in pretty-prints the entire searched value even when the assertion
  passes (~35ms per call on a rendered page), the override only formats on
  failure.
