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
# Format — copy a survivor line from the report and add a reason:
#   <path>:<line>:<col>  <from> → <to>   # why it is equivalent
#
# Do NOT list a mutant whose output the linter or type checker rejects. Biome's
# noDoubleEquals rule rejects every `=== → ==` and `!== → !=` mutant. The runner
# counts a static-check failure as killed, so those never survive to be recorded.
