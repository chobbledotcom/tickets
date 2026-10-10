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
# Format — one entry per line, plus a re-audit stamp and a reason:
#   <path>::<anchor>  <from> → <to>  audited:<hash>   # why it is equivalent
#
# The anchor names what the mutant sits inside — a function, a method, an object
# property, a value, nested names joined by dots — then `~` and a fingerprint of
# the expression it mutates:
#
#   src/fp.ts::collectionCache.generation~0dbfxl4  0 → 1  audited:041pxgm   # ...
#
# Both halves come from the code, so an entry that resolves has found the
# expression it was recorded against. An anchor moves only when that expression
# is edited or its enclosing name changes — never because code around it moved.
# The fingerprint never reaches past the mutant's own statement, so a change to
# a neighbouring line leaves it alone.
#
# The stamp dates the proof. It is `audited:` plus the short hash of the source
# file's text at the moment a person last re-derived the reason against that
# file. Every run and every audit re-hash the file: an entry whose stamp no
# longer matches is UNCONFIRMED — it suppresses nothing, the run reports it,
# and the audit lists it — until someone re-reads the reason against the
# current file and stamps the line again. A line without a stamp is malformed.
# `deno task check:equivalents --stamp <file>` prints the token a new or
# re-recorded line carries; a moved entry's replacement comes out of
# `deno task check:equivalents` with its stamp already on it. The audit never
# stamps anything itself: re-deriving a proof is a person's read.
#
# Two mutants sharing a name, a `from → to`, AND character-identical text are
# indistinguishable; those take `@1`, `@2` in source order. That ordinal is the
# one part of an anchor that a reordering can move, so an entry carrying one is
# worth re-checking whenever its neighbours change.
#
# Anything that would not survive a line — a space at either edge, the `#` that
# starts this comment, a newline, an arrow of its own — is percent-encoded, in
# the path just as in the `from` and `to`. `%23` is a `#`; `%20` is a space;
# `%e2%86%92` is a `→`. So a line beginning with `#` is always a comment, and a
# file whose path begins with one is written `%23...`.
#
# The path must name the canonical project-relative path, and nothing else.
#
# Do NOT list a mutant whose output the linter or type checker rejects. Biome's
# noDoubleEquals rule rejects every `=== → ==` and `!== → !=` mutant. The runner
# counts a static-check failure as killed, so those never survive to be recorded.
