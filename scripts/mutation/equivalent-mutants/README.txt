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
# The anchor names the thing the mutant sits inside — a function, a method, a
# value — with nested names joined by dots:
#
#   src/fp.ts::collectionCache.generation  0 → 1   # ...
#
# Where several mutants of the SAME kind sit inside one name they are numbered
# in source order, `@1`, `@2`. The ordinal uses `@` and not `#`, because a line
# ends with a `#` comment and a `#` in the anchor would start one early.
#
# Entries used to record <path>:<line>:<col>, which meant any edit ABOVE a
# recorded expression silently invalidated it. An anchor moves only when the
# thing it names does: renaming its function, or adding another mutant of the
# same kind inside that function. Both are real changes to what was recorded.
#
# Do NOT list a mutant whose output the linter or type checker rejects. Biome's
# noDoubleEquals rule rejects every `=== → ==` and `!== → !=` mutant. The runner
# counts a static-check failure as killed, so those never survive to be recorded.
