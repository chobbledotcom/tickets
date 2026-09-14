# Mutation testing

`deno task mutation` mutates operators in your source and checks whether your
tests fail. This page records how the runner works, its static gates, and the
registry of known-equivalent survivors. The policy — the 100% bar, who fixes a
survivor, when to run the gate — lives in "Mutation Testing" in AGENTS.md.

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

## How the run is isolated

Static gates apply mutants in isolated sibling copies. Mutants that pass are
written over the run's source file, tested in a fresh `deno test` subprocess,
then restored. The normal `deno task mutation` command first copies the current
checkout (including dirty source/test edits, excluding `.git`, cache/report
folders, local databases, secrets, and generated assets) to
`.mutation-runs/<id>/work`; test-stage writes and per-mutant bundle rebuilds
happen inside that copy, not the live files. Static worker copies are deleted
before tests start. A run deletes its main copy as soon as it ends — reporting
the failure if it cannot — so `.mutation-runs/` does not fill up with checkout
copies. While a run is going — and until the _next_ run starts — it has a small
`.mutation-runs/<id>/run.json` holding the child PID/status, so a stray run is
easy to find and stop. Starting a run clears out the folders of every earlier
run that is no longer going, including any whose `run.json` is unreadable
because it was killed mid-write:

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
`scripts/mutation/LICENSE.mutasaurus.md`.

## The `precommit:mutation` scope

The standalone `deno task precommit:mutation` runs it automatically, but only
over the files this branch changed (its committed diff against
`origin/main`/`main`): the step runs each source's mirror-located direct tests
first, whether or not the direct tests changed, then runs changed
`test/integration/`, `test/e2e/`, and `specs/` files only for survivors. A
changed Cucumber step or support file selects every Feature. Tests for unchanged
sources, scripts, and test helpers are outside that src mutation run. A
standalone mutation command still rejects any explicit test that neither mirrors
a selected source nor lives in an integration folder or `specs/`. The gate
demands a 100% kill rate, so the cost stays bounded to the source files you
actually changed.

## Static gates

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

## Known-equivalent survivors

Known-equivalent survivors recorded in `scripts/mutation/equivalent-mutants/`
are suppressed, as with a manual run. Never record `=== → ==`/`!== → !=`
mutants: Biome's `noDoubleEquals` rule is configured to reject loose comparisons
even against `null`, and the runner counts that lint failure as killed before
tests run. Use `deno task mutation:audit-equivalents` to check the whole
equivalent list with lint and type-check only; pass `--write` to remove entries
those static gates now kill. The audit never runs tests and refuses to rewrite
stale or malformed entries. Like `deno task mutation`, it works in a copy of the
checkout under `.mutation-runs/`, so the live source files are never left
mutated and a commit made while it runs cannot pick up a mutant. With `--write`,
the pruned `equivalent-mutants/` registry files are copied back when the run
ends — unless one was edited meanwhile, which fails the run instead of
overwriting the edit.
