# The stripe-mock start-count test read a port somebody else had taken

This note is the worked example that AGENTS.md cites for "A written-down
diagnosis is a hypothesis, not a finding". It records a diagnosis that was
wrong, the correction, and the fixes that followed. It is documentation, not a
job. The wider port question it points at is issue #2296.

`test/scripts/stripe-mock/lifecycle.test.ts` — "stops trying once the mock has
been started as many times as asked" — failed on CI twice on commits that
changed only Markdown (PR #2065 run 31501332067, and PR #2104 run 32130150568 at
24,020 of 24,021 passing), and passed reliably locally.

**The first diagnosis recorded for this failure was wrong.** It said the parent
read the count file before the last `/bin/sh` had appended its line. It cannot:
a failing attempt ends at `await stopProcess(spawned.process, ...)`, and
`stopProcess` awaits the child's `status` on both of its branches —
`beforeTimeout` resolves when the status does, and the timeout branch awaits it
after the SIGKILL. Every spawned child has therefore exited, and written, before
`startStripeMock` rejects.

The real cause is a stolen port. `attemptStartStripeMock` has exactly one early
return before it spawns: the port is already listening, so an unpinned attempt
gives up and asks for another. `withUnusedPort` picks a free port and lets go of
it before the start binds it, so another suite can take it in between — and that
attempt never spawns, so the count comes up one short. The sibling test at
"gives a mock time to shut itself down" already guarded against exactly this
with `retryWhilePortTaken`; `triesBeforeGivingUp` did not.

`triesBeforeGivingUp` now takes the count it wants and retries on a fresh port
while it comes up short, over the same shared helper. `retryWhilePortTaken`
takes an optional description, read only once every try is spent, so a run that
never gets a clean port reports what it actually saw.
