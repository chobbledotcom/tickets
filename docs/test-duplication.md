# Duplication limits for the test helpers: what each step down costs

This measured how tightly jscpd can scan the two test helper trees, priced every
setting we can choose, and records the decision taken and what is left to do.

**Decided and shipped.** The reusable helpers under `test/test-utils` are
scanned at **40 tokens**, alongside `src/`, by `.jscpd.helpers.json`. The
Cucumber support helpers under `test/specs/support` are scanned twice: at **19
tokens** alongside `src/`, and at **18 tokens** on their own by
`.jscpd.support.json`. See [Where we are](#where-we-are) for the remaining
steps.

All counts come from commit `ebc7c12` and from jscpd 5.0.12 with `minLines: 1`,
the setting every config in this repository uses. A count is the number of clone
pairs the scan reports, not the number of places to edit: one merge usually
clears several pairs.

## The six scans, and why there are six

The 0% threshold is not the number that decides how hard jscpd looks.
`minTokens` is. It sets the shortest run of tokens that counts as a clone, so a
lower number is a tighter net.

| Config                | Scans                            | minTokens |
| --------------------- | -------------------------------- | --------- |
| `.jscpd.json`         | `src`, `e2e-payments`, `scripts` | 19        |
| `.jscpd.specs.json`   | `src` + `test/specs/support`     | 19        |
| `.jscpd.support.json` | `test/specs/support`             | 18        |
| `.jscpd.helpers.json` | `src` + `test/test-utils`        | 40        |
| `.jscpd.test.json`    | `test`                           | 48        |
| `.jscpd.css.json`     | `src/ui/static/style.scss`       | 50        |

The last one holds no tests, so the rest of this document leaves it out. Its
number is high because design-token CSS repeats short declaration runs by
design, and those runs are not duplication.

Two trees hold reusable helpers. `test/specs/support` holds 76 files and 11,673
lines behind the Cucumber steps. `test/test-utils` holds 160 helper files and
19,164 lines, plus 32 files of tests for those helpers. Both are
production-shaped code: one named helper for each thing a person, or a test,
does. Two helpers that nearly match are a merge to make.

A test body is different. It repeats by design, and the shared mechanism is the
test framework itself. That is why the whole of `test/` sits at 48 tokens, and
why the helper trees can be held tighter than the tree that contains them.

## What a helper tree costs at each setting

### The Cucumber helpers hold at 19 until the curries land

`test/specs/support` reports no clones at 19 tokens. Below that the count rises
steeply:

| minTokens | Clone pairs |
| --------- | ----------- |
| 19        | 0           |
| 16        | 75          |
| 14        | 238         |
| 12        | 444         |
| 10        | 823         |

**An earlier version of this document called the pairs at 16 tokens noise, and
called 19 a floor. That was wrong.** The reasoning is recorded here so that it
is not repeated. It rested on a sample of eight pairs, and on one argument: that
a wrapper like this one is already a single call to the shared `openAdminPage`,
so the merge exists.

```typescript
const openKeysPage = (world: TicketsWorld): Promise<TestBrowser> =>
  openAdminPage(world, KEYS_PAGE);
```

The shared call is not what repeats. The wrapper shape repeats, and a curry
takes it. `browser.ts` already holds that curry:

```typescript
const openKeysPage = opensAdminPageAt(KEYS_PAGE);
```

A classification of all 78 pairs, rather than eight, gives this:

| At 16 tokens, the two sides…               | Pairs |
| ------------------------------------------ | ----- |
| call a shared helper — a curry takes them  | 46    |
| share only an assertion helper             | 5     |
| match on the signature and the types alone | 27    |

The 46 are merges. The 27 are the honest exception: two unrelated bodies behind
the same `(world: TicketsWorld, name: string)` parameter list. A named type for
that signature removes the repetition, and `ActOnOneThing` in
`test/specs/support/world.ts` is that type already.

### The factories exist, and the pairs mark who never adopted them

Every family the 46 fall into has a factory in `test/specs/support/browser.ts`
written for it. The pairs pile up at the call sites that hand-rolled the factory
instead:

| Factory                   | Files that use it | Sites that hand-roll it |
| ------------------------- | ----------------- | ----------------------- |
| `opensAdminPageAt`        | 2                 | 4, now 0                |
| `withAdminPage`           | 1                 | about 21                |
| `submitRenderedAdminForm` | 2                 | 9                       |

This is why the band read as noise. An under-adopted curry looks exactly like
unavoidable duplication, because the pairs cluster where the curry is absent.

### The remaining limit is the config, not the helpers

`.jscpd.specs.json` scans `src/` alongside the support helpers, so a helper that
reimplements production logic is flagged against the source it copied. `src/` is
clean at 19 and cannot go below it:

| minTokens | Clone pairs in `src/` alone |
| --------- | --------------------------- |
| 19        | 0                           |
| 17        | 497                         |
| 16        | 961                         |

So the number in _that_ config cannot come down. The support helpers therefore
get a second scan of their own, `.jscpd.support.json`, which drops `src/` and
holds them at 18. **19 is where the shared config sits, not where the helpers
have to stay.**

### What the curries cost, and where the helpers are now

Every family the 46 fell into was merged. The counts, measured after each step:

| minTokens | Pairs before | Pairs now |
| --------- | ------------ | --------- |
| 19        | 0            | 0         |
| 18        | —            | 0         |
| 17        | —            | 4         |
| 16        | 78           | 11        |

The merges, in the order they landed: `opensAdminPageAt` adopted at the four
files that hand-rolled it; `withAdminPage` widened to carry a result back and
adopted at seven; `keepsWhatTheOrganiserSaw` and `visiting` in `browser.ts`;
`forThisScenario` in `world.ts`; `organiserSavesFields`; the reader's presses,
the erase form and Refund All curried; the named step types `ActOnOneThing`,
`ReadAboutOneThing`, `AsksAboutOneThing` adopted at 31 helpers and the new
`ActOnTheStory` at nine more; `emailFor` moved out of `tickets.ts`;
`newcomerSends`, `recordPageUnder`, `wordsOnPageFrom`, `expectAccepted`,
`savesServedForm`, `expectNotBooked`; and the named shapes `PageRead`,
`StoredCounts`, `LineWithoutItsThing`, `FillsInServedForm` and
`SavesNamedThingsForm`.

Two helpers keep their own shape, and say why in a comment. `deposits.ts` joins
a person's names with a hyphen, so its address is a different address, not the
same one written twice. `asksNotToHearAboutPromotions` has to serve the choices
page before it can name the button on it, because serving the page is what loads
that group of copy. The specs caught the second one: a curry that named the
button as an argument named it too early.

The gate also caught a twin this work created. `savesBundleForm` repeated
`saveBundleForm`'s whole parameter list, and now takes
`Parameters<typeof saveBundleForm>` instead.

### The other test helpers moved from 48 to 40

`test/test-utils` was scanned only at 48 tokens, and only against the rest of
`test/`. These counts are for the helper files scanned together with `src/`,
before any merge:

| minTokens | Clone pairs |
| --------- | ----------- |
| 48        | 1           |
| 44        | 4           |
| 42        | 8           |
| 40        | 13          |
| 38        | 21          |
| 36        | 35          |

The single pair at 48 tokens was the find that made the scan worth adding.
`test/test-utils/test-state.ts` held its own copy of `createTableSql` and
`createIndexSql` from `src/shared/db/migrations/schema-sync.ts`. No config could
see it, because no config scanned `test/test-utils` against `src/`. The golden
test database was therefore built by a second copy of the production schema
builder, and could drift from it. It now calls `fullSchemaCreateStatements()`.

The 12 further pairs down to 40 tokens were real merges, and they landed. The
largest was a scaffold that 13 helper modules each spelled out for themselves:

```typescript
const { handleRequest } = await import("#routes");
const { mockFormRequest } = await import("#test-utils/mocks.ts");
```

`mocks.ts` already held `awaitTestRequest`, which does exactly this. It now also
exports `sendToApp` and `testPageHtml`, and every helper module goes through one
of the three.

## What is left, and what each step costs

These counts are for the helper files and `src/` at the commit above, after the
merges:

| minTokens | Clone pairs | Note                                       |
| --------- | ----------- | ------------------------------------------ |
| 40        | 0           | where the scan is set                      |
| 36        | 17          | strong signal, mostly whole shared helpers |
| 32        | 31          |                                            |
| 28        | 67          |                                            |
| 24        | 113         |                                            |
| 19        | 280         | parity with the Cucumber helpers           |

**These are counts, not verdicts.** A sample of the 24-token band showed valibot
schema fields that match across unrelated schemas, which is the same coincidence
that exempts `src/shared/db/migrations/schema/columns.ts` from `.jscpd.json`,
and one-line field builders that match on a signature. That is a sample, and the
Cucumber section above records what happens when a sample is read as a floor:
the pairs there turned out to mark an under-adopted curry, not noise. Classify a
band the way that section does, and try the curry, before calling any of it
unavoidable.

Each step down is a separate job. Take the number in `.jscpd.helpers.json` down,
bring the tree to it, and repeat, the way the comment caps in
`scripts/check-comments/run.ts` come down.

## The renamed-clone scan: same code with different words

jscpd matches literal token runs, so a rename hides a copy: every renamed word
breaks the run, and two spellings of one operation sit below `minTokens` 19. The
worked example was the slug-index family — `computeGroupSlugIndex`,
`computeNewsSlugIndex`, `computeSitePageSlugIndex`, and `computeSlugIndex` were
four spellings of `(slug) => hmacHash(slug)`, each one identifier short of
detection. All four were deleted and every caller now uses `hmacHash` directly.

`deno task cpd:renamed` (`scripts/cpd-renamed.ts`) catches that class. It runs
jscpd at 17 tokens over `src`, `e2e-payments`, and `scripts`, then keeps only
the pairs whose two sides share their whole punctuation shape — identical text,
or the same shape with different words. Import spans are skipped (the one
sanctioned repeat), and the registry itself is excluded from its own input.

The scan holds 102 pairs today, recorded in `scripts/cpd-renamed/allowed.json`:

| Kind          | Pairs | Meaning                                                                   |
| ------------- | ----- | ------------------------------------------------------------------------- |
| declared data | 28    | schema columns, machine edges, nav rows — one row per kind, by design     |
| by design     | 4     | deliberate API pairs and factory-call twins, each with its reason written |
| pending merge | 70    | the same code with different words — unify, then delete the entry         |

A pair leaves the registry one way: merge it (extract a helper, or curry the
parts that differ) and delete the entry. A registry entry is allowed to stay
only for a repeat that is by design, with the reason written in the entry. A new
word-only copy anywhere in the scanned trees fails the gate, which is the point:
the slug-index class of drift cannot regrow silently.

**Every count ratchets downward** — merge a family, run
`deno task cpd:renamed --update` to drop its entries, and repeat. The
`pending merge` list is the work order; the largest families at the time of
writing are the CSV export pair (`attendees-csv.ts` vs `calendar-csv.ts`),
`downloadRaw`/`downloadImage` in `src/shared/storage.ts`, and the `entity-pages`
tab strip row pair.

## What was measured and rejected

**A tighter scan for the whole of `test/`.** The tree is clean at 48 tokens and
very expensive below it:

| minTokens | Clone pairs in `test/` |
| --------- | ---------------------- |
| 48        | 0                      |
| 44        | 291                    |
| 40        | 873                    |
| 36        | 1,749                  |
| 32        | 3,385                  |

The rise is test bodies, not helpers, so a lower number here buys little and
costs a great deal. 48 stays.

**A carve-out for `test/test-utils` in `.jscpd.test.json`.** The specs config
takes `test/specs/support` out of the ordinary `test/` scan. That hides any
clone between a support helper and a test body, and today the count of those is
zero, so nothing is lost. `test/test-utils` is not carved out: it stays in both
scans, so its clones against test bodies are still caught at 48. The second scan
of 19,000 lines costs about one second.

## Where we are

- **Done.** `test/test-utils` scanned at 40 tokens against `src/`. The
  production-schema reimplementation removed. 12 helper merges landed.
- **Done.** Every curry family in `test/specs/support` merged, and
  `.jscpd.support.json` added at 18 tokens. The pairs at 16 tokens went from 78
  to 11.
- **Next.** Take `.jscpd.support.json` to 17. Four pairs, and each needs a
  judgement: two unrelated bodies behind one parameter list want a named type,
  and `somethingForSale` is exported twice, from `editors.ts` and
  `shown-code.ts`, with different options. That last one is a real unification,
  not a signature coincidence.
- **Next.** Take `.jscpd.helpers.json` to 36 tokens. 17 pairs, mostly whole
  helpers that duplicate a sibling.
- **Then.** 32, 28, and below. Classify each band before you price it, and reach
  for a curry before you call any pair unavoidable.
