# Comment limits: the measurement, the options, and where we are

This measured what the comments in `src/` cost, tested the three claims that
prompted the question, priced every cap we could set, and now records the
decision taken and what is left to do.

**Decided and shipped.** A comment may run at most **20 lines**, and one of its
lines at most **100 columns**. `deno task check:comments` enforces both in
`precommit`; the numbers live in `scripts/check-comments/run.ts` and are meant
to come down. See [Where we are](#where-we-are) for the remaining steps.

All measurements come from `src/` at commit `470b47e` (1,181 files, 161,904
lines), counted with the repo's own lexer (`scripts/typescript-lex.ts`), so a
`//` inside a string is never miscounted. They describe the tree **before** the
first ratchet step, which is what makes the costs below meaningful.

**One unit, used throughout.** A "comment" below means one comment as the lexer
sees it — a `/* */` or `/** */` block, or a single `//` line — and excludes the
machine-read directives, which are not prose and cannot be deleted. Every table
in this document counts that way, so a cap in one table can be compared with a
cost in another. Two other counts exist and are reported once, here, so they are
never confused with the working unit:

- **12,045** comments including directives, of which **630** are directives: 542
  `jscpd:ignore`, 80 `<reference`, 7 `deno-lint-ignore`, 1 `biome-ignore`. Those
  four are every directive in `src/`, and they sum to the 630.
- **9,744** comment _blocks_, which is the same corpus with each run of
  consecutive `//` lines merged into one. Only the "blocks" figure uses this;
  nothing is priced against it.

## What is there now

|                                   |                           |
| --------------------------------- | ------------------------- |
| Prose comments                    | 11,415                    |
| Prose comment lines               | 29,433 (18.2% of `src/`)  |
| All comment lines inc. directives | 30,071 (18.6%)            |
| Median prose comments per file    | 4 (p90 = 25, worst = 142) |
| Files with no prose comments      | 122 (10.3%)               |

The shape matters more than the total. Sorted by how many lines each size of
comment occupies (rows sum to the 11,415 / 29,433 above):

| Comment length | Comments | Lines | Share of comment mass |
| -------------- | -------- | ----- | --------------------- |
| 1 line         | 7,126    | 7,126 | 24.2%                 |
| 2 lines        | 893      | 1,786 | 6.1%                  |
| 3–4 lines      | 1,523    | 5,178 | 17.6%                 |
| 5–9 lines      | 1,433    | 9,088 | 30.9%                 |
| 10+ lines      | 440      | 6,255 | 21.3%                 |

**Half the prose lives in 1,873 comments — 16% of the comments.** The 7,126
one-liners are 62% of the comments but under a quarter of the text.

Separately: 837 files (71%) open with a header docstring, and those headers are
6,196 lines — 21% of all comment lines on their own. 538 of them run to five
lines or more.

## The three claims, tested

### "A lot of time is spent reformatting comments" — true, and nothing helps

Biome does **not** reflow comment text. Tested directly: a 190-character
one-line docstring survives `biome format --write` untouched, and two short `//`
lines are never joined. Every comment's 80-column wrapping is therefore
maintained by hand, and the fingerprint is visible in the corpus — of the 22,305
lines inside multi-line comments:

- 49.4% sit in columns 70–80, the band you only land in by deliberately filling
  to the margin;
- 1,291 lines have already drifted **past** 80 columns, because no check looks.

So the wrapping is hand-made, and it is not even holding. In history (1,548
commits touching `src/`), comments are 14.0% of all changed lines, and **16.2%
of comment churn happened in hunks that changed no code at all** — 3,755 hunks,
12,994 lines of pure prose editing.

### "Comments inevitably drift" — true, but smaller than it feels

Searching every backticked reference inside a comment for the thing it names:

- **21 stale identifiers** — `ATTENDEE_JOIN_SELECT`, `checkLineCapacity`,
  `ReorderControls`, `computeAttendeeStats` and friends exist only in the
  comment that mentions them;
- **8 stale paths** — five point into `test/lib/`, a directory that no longer
  exists.

Roughly 239 comments (2.1%) explain what the code _used to_ do, which
`AGENTS.md` already forbids. `src/shared/db/attendees/select.ts` opens with nine
lines on the two fat SELECT projections it replaced — both long deleted.

So drift is real and demonstrable, but it is tens of comments, not thousands. It
is not on its own an argument for a cap.

### "The code is not sufficiently self-documenting" — the weakest of the three

A deliberately conservative detector (comment sits directly above a declaration,
six content words or fewer, nearly all of them already in the identifier) finds
**454 comments that only restate the name below them**. `AGENTS.md` bans this
class in as many words. Samples:

```text
/** Service account email address */   serviceAccountEmail: string;
/** Error result with message */       type ErrorResult = …
/** Create */                          const handleCreate: RouteHandlerFn = …
```

The real figure is higher — the detector ignores anything over six words — but
this is hundreds of comments, not the bulk. Most comments are not restatements.
The complaint the data actually supports is that comments are too **long**, not
that there are too many.

## Why "number of comments per file" is the wrong unit

Three independent reasons, any one of which is disqualifying.

**1. It aims at the wrong half of the corpus.** A count cap treats a 30-line
docstring and a five-word note as one thing each. A file with a single 44-line
header passes a cap of 1; a file with six sharp one-liners fails it. The cap
would delete the cheap, accurate comments and leave the long prose that actually
drifts.

**2. It is satisfied by splitting the file.** Comments move with the code they
sit on, so any count cap can be met by cutting a file in two — and `AGENTS.md`
already pushes files toward 400 lines, so the escape hatch is not just open, it
is signposted. Arithmetically, holding today's 11,415 prose comments under a cap
needs at least this many files:

| Cap | Files needed | We have 1,181       |
| --- | ------------ | ------------------- |
| 1   | 11,415       | 9.7× more           |
| 2   | 5,708        | 4.8× more           |
| 3   | 3,805        | 3.2× more           |
| 5   | 2,283        | 1.9× more           |
| 10  | 1,142        | already satisfiable |

A cap of 10 is met today by shuffling; a cap of 5 is met by doubling the file
count. Neither outcome is the one we want.

**3. Directives eat the budget.** 309 files (26%) carry comments that are not
prose at all, and 299 of them carry two or more — a `jscpd:ignore-start` /
`-end` pair around an import block, in 263 files. One file carries seven. Any
cap under 3 is unmeetable for a quarter of `src/` unless directives are exempt,
which any real rule would do anyway.

## Every option, priced

Directives exempt throughout. "Files over" is how many files fail on day one;
"lines" is roughly how much prose has to go. Every figure here is the **whole**
cost of adopting that rule, not a per-step one — the staged table further down
splits the same totals into per-PR instalments.

| Rule                                      | Files over | Comments to rewrite | Lines removed |
| ----------------------------------------- | ---------- | ------------------- | ------------- |
| **A — max comments per file**             |            |                     |               |
| 3 comments                                | 652 (55%)  | 8,760               | 14,742        |
| 5 comments                                | 527 (45%)  | 7,525               | 11,236        |
| 10 comments                               | 338 (29%)  | 5,315               | 6,718         |
| **B — max comment lines per file**        |            |                     |               |
| 10 lines                                  | 633 (54%)  | —                   | 20,934        |
| 20 lines                                  | 443 (38%)  | —                   | 15,511        |
| 30 lines                                  | 330 (28%)  | —                   | 11,612        |
| **C — max share of file that is comment** |            |                     |               |
| 10%                                       | 706 (60%)  | —                   | 16,250        |
| 15%                                       | 586 (50%)  | —                   | 11,179        |
| **D — max lines in any one comment**      |            |                     |               |
| 1 line                                    | 910 (77%)  | 4,289               | 18,018        |
| 2 lines                                   | 866 (73%)  | 3,396               | 13,729        |
| 4 lines                                   | 714 (60%)  | 1,873               | 7,851         |
| **E — header docstring only**             |            |                     |               |
| ≤ 1 line                                  | 753 (64%)  | 753                 | 5,359         |
| ≤ 3 lines                                 | 596 (50%)  | 596                 | 3,873         |

Read D against the mass table: **max 2 lines removes 13,729 lines while touching
3,396 comments** — a third of the comments carrying nearly half the prose. Cap A
at 3 has to touch 8,760 comments to remove fewer lines.

## What a strict limit would actually cost

**It would delete comments `AGENTS.md` holds up as exemplary.** The guide cites
`src/shared/validation/timestamp.ts` under "Deliberate non-use is fine when the
platform is better" — and that file's docstring runs 22 lines. Its load-bearing
sentence ("valibot's `isoTimestamp` only checks the format and so accepts
overflow days like Feb 30") is one line; the other twenty re-narrate the code
below. So the tension is real but mostly compressible — which is the argument
for a length cap rather than a ban.

**Three existing rules mandate comments.** `AGENTS.md` requires a comment on an
empty `catch` whose fallback is the contract (61 `catch {` sites in `src/`), a
"why the absence is expected" note on `*OrNull` returns (139 mentions across 12
files), and a reason at any hand-rolled utility. `// test-groups: run-alone` is
read by `scripts/test-groups.ts`. None of these is threatened by a length cap;
all of them are threatened by a tight count cap.

**`deno doc` output would shrink.** `src/doc.ts` and the eleven barrels in
`src/docs/` exist only to generate API documentation from jsdoc — 67% of `src/`
comments are jsdoc, and they are what a reader sees on hover. Those barrel files
are almost entirely `@module` prose and must be exempt from any ratio rule or
they fail by construction.

**Agents lose their cheapest channel.** This repo is largely agent-built. A
comment is how one session's decision reaches the next without re-reading 2,232
commits. Cutting prose is safe only if the durable "why" moves somewhere — a
`specs/` Feature for a business rule, `TODO.md` for a deferred idea, `docs/` for
a design decision — rather than being deleted.

Two feared costs turn out not to exist:

- **jscpd is comment-blind.** Proved directly: two identical functions, one with
  a comment inserted mid-body, still report as one 76-token clone, and both
  files tokenize identically. Deleting comments cannot create a new duplication
  finding, so the 0% threshold is not at risk.
- **File-size pressure eases.** `src/` has 54 files over the 400-line guideline;
  on code lines alone it would be 29. Comments are what push 25 files past it.

## Recommendation

**Cap the length of one comment at two lines. Do not cap the count.**

The case is that this is not new policy. `AGENTS.md` already says "One or two
lines is the norm; a paragraph above a few lines of code is a smell" — and 29.8%
of comments break it, with 16.4% at the "paragraph" size. The gap is not a
missing rule, it is that nothing checks the rule we wrote. A length cap:

- hits the half of the prose that actually drifts, and leaves 7,126 accurate
  one-liners alone;
- cannot be gamed by splitting a file;
- leaves every mandated comment (`catch`, `*OrNull`, hand-rolled reason,
  `test-groups:`) legal;
- shrinks the wrapping problem to almost nothing — at two lines there is barely
  a wrapping decision left to re-make.

Exempt machine-read directives and `src/docs/*.ts` (the `deno doc` barrels).
Consider exempting the module header, or hold it to the same two lines and move
what it was carrying into `docs/` — 837 headers are the single biggest block of
work either way.

**Land it by lowering one number, not by grandfathering files.** The repo has no
allow-lists and should not gain one. Set the cap in config at a number that
passes today and lower it per PR; each step is bounded.

The first two columns are **incremental** — the work that one PR takes on, being
only the comments that step newly catches. The last column is the running total,
and it is what matches option D above: the cumulative figure at ≤ 2 is 3,396,
the same number option D prices.

| Step | Comments this step | Files this step | Cumulative comments |
| ---- | ------------------ | --------------- | ------------------- |
| ≤ 20 | 41                 | 38              | 41                  |
| ≤ 12 | 132                | 118             | 228                 |
| ≤ 8  | 332                | 259             | 560                 |
| ≤ 6  | 438                | 296             | 998                 |
| ≤ 4  | 875                | 429             | 1,873               |
| ≤ 3  | 609                | 334             | 2,482               |
| ≤ 2  | 914                | 412             | 3,396               |

(The ≤ 16 step, omitted for brevity, adds 55 comments between ≤ 20 and ≤ 12.)
Each step's own cost falls and rises because the comments are not spread evenly
across lengths — ≤ 4 catches a large cluster, ≤ 3 a smaller one. The last three
steps are still large and would split by directory.

**If a stricter version is wanted, the honest maximum is one line, not zero.**
It costs 4,289 comments and 18,018 lines, and it ends hand-wrapping outright — a
comment that must fit on one line at 80 columns can never be reformatted. Zero
is not available: the directives are comments too.

**Two things worth doing whichever way this goes**, because both enforce rules
that already exist:

1. Fail on a comment line over 80 columns. Nothing catches them today.
2. Delete the 29 comments naming code that no longer exists, and the ~239 that
   explain what the code replaced.

Biome has no rule for any of this, so enforcement is a script. `skipComment` in
`scripts/typescript-lex.ts` already does the parsing; a checker plus its
`precommit` step is roughly 80 lines.

## Where we are

The checker is in `scripts/check-comments/`, wired into `precommit`, and the
tree is green at **20 lines and 100 columns**. Both numbers ratchet: lower one
in `run.ts`, bring the tree to it, repeat. Directives, the `deno doc` barrels,
and shipped dated migrations are exempt — the last because they are append-only
history the repo already declines to edit, the same reason `.jscpd.json` ignores
that glob.

Two things the analysis got wrong, found by building it:

- **The width problem is bigger and more independent than measured.** The 1,291
  figure above counts only lines inside multi-line comments. Including
  single-line comments it is **1,708 over 80 columns, across 459 files**, and
  88% of them sit at 81–85 columns. Length capping barely dents it: even at a
  one-line cap, 417 remain, because a one-line comment can still be 120 columns
  wide. That is why the width limit starts at 100 rather than 80, and why it has
  to ratchet separately from the length limit.
- **The count of over-length comments was slightly understated**, because the
  lexer was mis-parsing regular expressions and lost its place in three files.
  Fixing it revealed three comments in `db/client.ts` and `schema-sync.ts` that
  had been hidden.

Remaining steps, from the staged table above, now that ≤ 20 is done:

| Next | Comments to rewrite | Files touched | Cumulative |
| ---- | ------------------- | ------------- | ---------- |
| ≤ 16 | 55                  | 51            | 96         |
| ≤ 12 | 132                 | 118           | 228        |
| ≤ 8  | 332                 | 259           | 560        |
| ≤ 6  | 438                 | 296           | 998        |
| ≤ 4  | 875                 | 429           | 1,873      |
| ≤ 3  | 609                 | 334           | 2,482      |
| ≤ 2  | 914                 | 412           | 3,396      |

On width, 100 → 90 is about 80 comments and 90 → 80 about 1,470 more, so the
last step there is the single biggest piece of work left in this whole plan.

One judgement worth recording for whoever takes the next step: bringing a
docstring under a limit is not a formatting job. Most of what came out was
narration of the code below, or an account of what the code used to be — the
[banned classes](#the-three-claims-tested), not the load-bearing "why". When a
comment resists shortening, that is the signal AGENTS.md describes: the code
underneath probably wants the clarity instead.
