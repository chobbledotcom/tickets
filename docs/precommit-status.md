# Precommit status records

Precommit records its progress under `.diagnostics/precommit/`. Each invocation
owns one UUID JSON file. Atomic replacement publishes complete records.

The Nix-built `agent-diagnose checks` command reads these records. Its source
lives in the dotfiles `modules/agent-diagnostics/` module, not this repository.
OpenCode's global instructions name the permitted immutable executable.

## Stored facts

Each record contains the PID, creation time, latest transition time, state,
step, step completion time, and exit code. It contains no arguments, paths,
error text, or log output. The producer uses canonical UTC timestamps.

| State     | Required facts                                                     |
| --------- | ------------------------------------------------------------------ |
| `waiting` | No step, completion time, or exit code.                            |
| `running` | A declared step and no exit code. The completion time is optional. |
| `passed`  | Exit code zero.                                                    |
| `failed`  | A nonzero exit code.                                               |

`updatedAt` records transitions, not a heartbeat. A completed step can remain
visible while the invocation waits at the optional push prompt. Abrupt
termination leaves the last record. A stored PID does not prove process identity
or current activity.

Records remain after completion. The directory is ignored by Git and excluded
from mutation snapshots. The diagnostic reader reports truncation when its
record or output limits prevent a complete result.

## Implementation

`PrecommitStatusSchema` in `scripts/precommit/status-schema.ts` validates record
facts. `PRECOMMIT_STEP_NAMES` derives labels from the actual step definitions.
`runWithPrecommitStatus` in `scripts/precommit/status.ts` records transitions.
`scripts/precommit/runner.ts` connects the producer to the real checks.

Direct tests in `test/scripts/precommit/status*.test.ts` cover concurrent
invocations, complete atomic records, failures, privacy, and schema boundaries.
