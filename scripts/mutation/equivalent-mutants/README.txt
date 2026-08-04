# Known-equivalent mutants — suppressed from the survivor count.
#
# A mutant is "equivalent" when NO possible input distinguishes it from the
# original, so no test could ever kill it. Recording it here lets the mutation
# tester gate CI on genuinely NEW survivors instead of re-reporting these.
#
# Equivalent means unkillable by *any* test — not merely unkilled by the ones
# that exist today. A survivor a stronger assertion could catch is a test gap,
# not an equivalent: fix the test instead of listing it here. Prefer entries
# whose equivalence is provable from types (e.g. `?? → ||` where the operand is
# never falsy-but-non-null) over ones that lean on a domain invariant.
#
# The registry is this directory: every `*.txt` file in it is loaded and
# the entries merged, so records can live in focused per-area files. Add a
# new record to the file whose name covers the source path (splitting a
# file that outgrows ~400 lines).
#
# Format — one entry per line, plus a reason:
#   <path>::<anchor>  <from> → <to>   # why it is equivalent
#
# The anchor names what the mutant sits inside — a function, a method, an object
# property, a value, nested names joined by dots — then `~` and a fingerprint of
# the expression it mutates:
#
#   src/fp.ts::collectionCache.generation~0dbfxl4  0 → 1   # ...
#
# Both halves come from the code, so an entry that resolves has found the
# expression it was recorded against. An anchor moves only when that expression
# is edited or its enclosing name changes — never because code around it moved.
# The fingerprint never reaches past the mutant's own statement, so a change to
# a neighbouring line leaves it alone.
#
# Two mutants sharing a name, a `from → to`, AND character-identical text are
# indistinguishable; those take `@1`, `@2` in source order. That ordinal is the
# one part of an anchor that a reordering can move, so an entry carrying one is
# worth re-checking whenever its neighbours change.
#
# Anything that would not survive a line — a space at either edge, the `#` that
# starts this comment, a newline, an arrow of its own — is percent-encoded.
# `%23` is a `#`; `%20` is a space; `%e2%86%92` is a `→`.
#
# The path must be written exactly as the canonical project-relative path.
#
# Do NOT list a mutant whose output the linter or type checker rejects. Biome's
# noDoubleEquals rule rejects every `=== → ==` and `!== → !=` mutant. The runner
# counts a static-check failure as killed, so those never survive to be recorded.
