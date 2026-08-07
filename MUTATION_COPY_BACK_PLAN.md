# Make interrupted copy-back tests deterministic

## Current-system value

`deno task test` will prove that an interrupted mutation run cannot copy files
back after waiting for the checkout lock without relying on a real-time sleep.

## Trusted facts

- `runInSnapshot` reads each kept file before creating the snapshot. This gives
  copy-back the checkout text that the run started from.
- The termination handler latches interruption in the run supervisor. Once it is
  true, it stays true.
- `withCopyBackLock` serializes every mutation run that copies files into one
  checkout.
- The interruption callback is checked after the copy-back lock is acquired.
  Waiting for the lock can therefore change the answer from false to true.
- A run record and exit code are observed results. They do not authorize a file
  write.

## Valid states

| State                   | Required facts                                            | Allowed result                                              |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Ready to copy           | Lock held; run not interrupted                            | Compare and copy kept files                                 |
| Waiting to copy         | Another run holds the lock                                | Wait without changing checkout files                        |
| Interrupted before copy | Interruption latched before the locked callback checks it | Copy no files and report no copy failure                    |
| Copy failed             | Lock held; file changed or file IO failed                 | Restore this run's writes where possible and report failure |
| Finished                | Child and copy-back outcomes settled                      | Write one final run record and return its exit code         |

The existing run-record variants remain unchanged. No new stored state or schema
is needed.

## Commands and events

| Starting state       | Command or event                       | Required result                                                   |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Waiting to copy      | Termination signal                     | Latch interruption; copy no kept files after the lock is acquired |
| Waiting to copy      | Lock becomes free without interruption | Acquire it, compare the checkout, and copy the run's changes      |
| Ready to copy        | Checkout file changed during the run   | Leave every kept file unchanged and report copy failure           |
| Running or finishing | Exact command rerun                    | Start a separate snapshot run with a new run id                   |

## Failure table

| Work completed        | Failure                                       | Required result                                                                        | Retry owner                                                  |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| No copy-back write    | Signal arrives while waiting for the lock     | Leave checkout files unchanged; settle the run as interrupted with exit code 130       | Developer reruns the command if wanted                       |
| No copy-back write    | Checkout file changed                         | Leave all kept files unchanged; settle the run as failed                               | Developer resolves the edit and reruns                       |
| Some copy-back writes | Later file IO fails                           | Put back this run's writes where they are still unchanged; report the original failure | Developer fixes IO and reruns                                |
| No test result        | Test cannot prove the waiter reached the lock | Do not use elapsed time as proof; test the locked production helper directly           | Test suite reruns only for unrelated infrastructure failures |

## Retry and replay

- Each command run has a new run id and snapshot directory.
- An interrupted run is not resumed automatically. A developer may rerun the
  command, producing a new isolated run.
- The checkout-wide lock stops two runs from copying at once.
- The original file text stops a later run from overwriting a change made by an
  earlier run or by the developer.
- A changed checkout file and an unrecoverable file IO error are permanent for
  that run.
- One failed run does not block a later run after its lock and claim are
  released.

## Concurrency

| Operation A                  | Operation B                    | Required result                               | Protection                                             |
| ---------------------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| Run waits for copy-back lock | Termination signal arrives     | Run copies nothing after it acquires the lock | Latched interruption checked inside the lock           |
| Run copies kept files        | Another run finishes           | Only one run copies at a time                 | Checkout-wide copy-back lock                           |
| Run copies kept files        | Developer edits a kept file    | Developer's edit remains; run fails           | Original-text comparison before every write            |
| Run puts back its writes     | Developer edits a written file | Newer developer edit remains                  | Restore only when the file still holds this run's text |

## Owner choices

None. Interruption means the run must not start copy-back, and a concurrent
checkout edit always wins over snapshot output.

## Security and privacy

- This is local developer tooling. It adds no application role, route, link,
  network request, database call, secret, or personal data boundary.
- File paths still come from the mutation command's fixed copy-back list.
- The change does not widen which files a snapshot may read or write.

## Shared contract

Keep one production helper for the lock-and-recheck operation. `runInSnapshot`
uses that helper, and its direct test controls the lock and interruption
callback with promises. The test must not expose a second implementation or use
a delay to infer scheduler state.

The helper keeps the existing contract:

```typescript
((
  wasInterrupted: () => boolean,
  root: string,
  workRoot: string,
  copyBack: CopyBackFile[],
) => Promise<number>);
```

It returns `0` without calling file copy-back when interruption is true after
the lock is acquired. Existing copy-back errors continue to return `1`.

## Adversarial review

- A signal before the child starts is already covered and remains exit code 130.
- A signal after a running child stops is already covered and remains exit code
  130.
- A signal while waiting for copy-back is the fragile case. Holding the real
  lock, starting the production helper, then changing the latched answer before
  releasing the lock proves it without timing.
- There is no external success or follow-up provider read.
- Replay cannot reuse a snapshot because every run receives a new id.
- Two finishing runs cannot interleave writes because they share one lock.
- A stale checkout cannot be overwritten because each file is compared with its
  starting text.
- The direct helper is also the production caller's one implementation. It is
  not a test-only alternative.

## Pull request

One standalone pull request based on `main`:

- Current value: deterministic proof that an interrupted lock waiter copies no
  files.
- Old path replaced: the orchestration test's 30 ms sleep and scheduler guess.
- Expected source files: `scripts/mutation/isolation.ts`, at most 10 changed
  source lines with no new behavior branch.
- Expected test files: `test/scripts/mutation/isolation/copy-back.test.ts` and
  `test/scripts/mutation/snapshot-copy-back.test.ts`, with the flaky case moved
  to the direct copy-back suite.
- Expected registry file: `scripts/mutation/equivalent-mutants/scripts.txt`,
  updating the helper name attached to the existing equivalent mutant proof.
- Database calls: none.
- Provider or network calls: none.
- Stack position: independent of payment provider ownership and based directly
  on `main`.

## Proof

1. Before the refactor, the deterministic direct test cannot import the locked
   production helper. The existing orchestration test relies on a 30 ms sleep.
2. The direct test holds the real copy-back lock, starts the helper, latches
   interruption, releases the lock, and proves the live file was not changed.
3. Existing interruption tests continue to prove exit code 130 and the final
   interrupted run record.
4. The focused mutation isolation tests pass without a real-time wait.
5. `nix develop -c deno task precommit` passes.

## Open questions

None.
