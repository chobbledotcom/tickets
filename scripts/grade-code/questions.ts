/**
 * The Jev questions: the judgement halves of the code-quality rules in
 * AGENTS.md, asked as one TypeSafe call per file. Each is a 0-3 score where
 * high is good, so a FAIL names a real gap in the file's quality and a WARN
 * names a borderline one. The questions only judge what the state carries,
 * and the state carries the file's source plus line-addressed evidence the
 * mechanical pass extracted, so every answer stays grounded in the file.
 */

import type { CodeFacts } from "./extract.ts";

/** One judgement AGENTS.md spells out but a machine scan cannot make. The
 * TypeSafe score shape and the pass/warn thresholds are added when the
 * question joins the check schema, so every entry carries only what
 * differs. */
export interface JevQuestion {
  /** The four legend lines, worst to best. */
  criteria: [string, string, string, string];
  id: string;
  instructions: string;
  label: string;
  /** Which files the question applies to. */
  requires?: (facts: CodeFacts) => boolean;
  weight: number;
}

/** The TypeSafe question one judgement becomes on the wire. */
export interface ScoreQuestion {
  criteria: [string, string, string, string];
  instructions: string;
  type: "score";
}

/** A file that shows copy to a reader: a template, or JSX anywhere else. */
const showsCopy = (facts: CodeFacts): boolean =>
  facts.kind === "template" || facts.rendersJsx;

const withWriteCalls = (facts: CodeFacts): boolean =>
  facts.writeCalls.length > 0;

export const JEV_QUESTIONS: JevQuestion[] = [
  {
    criteria: [
      "Comments re-narrate code or restate names throughout; deleting them loses nothing",
      "Mostly narration with one or two comments that carry a real why",
      "Comments carry real constraints and surprises; at most one restates a name",
      "Every comment adds what the code cannot say, and none re-narrate lines or restate a name",
    ],
    id: "comments_earn_place",
    instructions:
      'Judge the comments in `comments` against "Comments are short" in AGENTS.md. A comment earns its place only when it adds what the reader cannot see: a why, a constraint, a surprise. Penalise comments that re-narrate the lines below in prose, restate a function name beside it (`/** Save the listing. */` above saveListing), or explain a language feature. A short file-header naming what the file is (`/** The owner-only attendee-status page. */`) is the house pattern, not a finding, and a schema-driven page that needs no comment between its fields is the goal, not a gap: silence where names carry the meaning scores high. The bar: would a competent reader be surprised or misled without it?',
    label: "Comments earn their place",
    weight: 4,
  },
  {
    criteria: [
      "Several comments live in the past, comparing or explaining replaced code",
      "One stale historical comment survives",
      "Comments describe today's code, with at most a passing historical aside that still informs",
      "Every comment describes the code as it works now",
    ],
    id: "comments_current",
    instructions:
      'Judge whether the comments in `comments` describe the code as it works now, per "Comments describe current code" in AGENTS.md. Penalise comments that compare current code with an old implementation, explain what the code replaced, or narrate history. Git keeps the past; a reader meeting the file today must not be told about a version that no longer exists.',
    label: "Comments describe current code",
    weight: 2,
  },
  {
    criteria: [
      "Jargon-heavy names and comments; a plain-language reader is lost",
      "A few jargon words where a plain phrase works, or one needlessly cryptic name",
      "Mostly plain domain words, with jargon only where no plain phrase works",
      "Plain language throughout; a ten-year-old understands the comments and method names",
    ],
    id: "plain_language",
    instructions:
      'Judge the file against "Plain language for functional code" in AGENTS.md: helpers and comments must explain themselves in simple domain words, so a reader without a computer-science degree understands them. `jargon_hits` lists CS words the code uses (predicate, cohort, projection, fold, atom, and friends). Score a hit down only when a plain phrase works in its place; an established domain term of the site itself is fine. Also penalise helper names and comments that only a CS graduate can decode.',
    label: "Plain language, no CS jargon",
    weight: 3,
  },
  {
    criteria: [
      "Imperative plumbing throughout: manual index loops, forEach misuse, hand-folded maps and filters",
      "A few manual accumulations or forEach calls a curried helper already covers",
      "Mostly functional composition with one or two imperative leftovers",
      "Clean functional composition from #fp-style curried helpers throughout",
    ],
    id: "fp_composition",
    instructions:
      'Judge the file against "Use FP methods" in AGENTS.md: prefer curried functional utilities from `#fp` and map/filter/pipe/reduce over imperative loops and manual accumulation. `for_each_calls` lists `.forEach(` uses, which the repo asks to become `for...of` or a curried helper. Penalise hand-rolled accumulation a `reduce` or `pipe` already covers, and repeated `.map(...).filter(...)` chains a curried helper would fold. A plain `for...of` that reads well is fine; the rule targets manual plumbing, not iteration itself.',
    label: "FP composition over loops",
    weight: 3,
  },
  {
    criteria: [
      "Large hand-nested construction a schema and one renderer would collapse",
      "Repetitive hand-written blocks with a schema-shaped outline visible",
      "Mostly schema-driven, with one or two hand-built sections that would not fit the schema",
      "Content is data, rendered by one shared function; invalid arrangements cannot be written",
    ],
    id: "schema_over_organic",
    instructions:
      'Judge the file against "Schema over organic structure" in AGENTS.md: model content as a typed list of data (sections, entries, fields) rendered by one shared function, rather than hand-nested repetitive markup or construction. The reference is the admin guide: each topic exports a GuideSection[] and renderGuideSections turns it into markup. Penalise long stretches of near-identical hand-written construction that a schema plus one renderer would collapse, and branching that exists only to vary one field of a shape.',
    label: "Schema over hand-nesting",
    weight: 4,
  },
  {
    criteria: [
      "Long branch chains dispatch case by case; a new case falls through silently",
      "A branch chain exists but each arm is small and the set of cases is closed",
      "Mostly shared-interface dispatch with one chain that would not fold in cleanly",
      "Cases are data: exhaustive Record or per-entry handlers, so a new case cannot be missed",
    ],
    id: "shared_dispatch",
    instructions:
      'Judge the file against "Shared interfaces over branch-per-case" in AGENTS.md: a typed union plus an exhaustive Record keyed by it, or per-entry handlers that carry their own rules folded uniformly, beats a chain of if/else arms bolted onto a dispatcher. A forgotten case must fail to compile or throw, not silently fall through to a default arm. Penalise long ternary or if chains that dispatch on a value, and switch statements with a default that swallows new cases.',
    label: "Shared interface over branch chains",
    weight: 3,
  },
  {
    criteria: [
      "Parallel single and multiple implementations that can drift",
      "A length === 1 or single-vs-many branch that changes behaviour",
      "One collection path; at most a thin wrapper that delegates to it",
      "One path modelled over a collection everywhere, singular answers derived from array results",
    ],
    id: "one_path_one_or_many",
    instructions:
      'Judge the file against "One path for one-or-many" in AGENTS.md. Penalise a separate single-item path beside a multiple-item one (getThing next to getThings, a length === 1 branch that renders or loads differently). A thin singular wrapper that delegates to the array implementation is fine. Callers passing an array of one and deriving the singular answer from its result is the pattern the repo wants.',
    label: "One path for one-or-many",
    weight: 3,
  },
  {
    criteria: [
      "Errors are swallowed or defaulted away; missing expected values become corrupt data",
      "One or two fallbacks paper over values the code treats as expected",
      "Errors propagate loudly; fallbacks sit only on genuinely optional values",
      "Loud failures throughout: boundaries validate and throw, catches are narrow with real recovery paths",
    ],
    id: "offensive_errors",
    instructions:
      'Judge error handling against "Offensive Programming — Never Suppress Errors" in AGENTS.md. `fallback_operators` lists every `??`, `||`, and `?.` with its line; `catch_clauses` lists catches. Score each down when it papers over a value the code treats as expected (a missing field from structured data, a lookup that must succeed), and score `??`/`||`/`?.` on genuinely optional values as fine. Penalise catch-and-continue, catch blocks wider than the recovery point, and silent stand-ins (empty string, 0, -1, empty array) returned as "not found". A documented *OrNull return or a commented fallback is the sanctioned shape.',
    label: "Offensive, not defensive",
    weight: 5,
  },
  {
    criteria: [
      "Lookups return silent stand-ins; assertions claim shapes nothing checked",
      "One lookup falls off the end with a stand-in, or assertions replace parsing",
      "Lookups throw with context, or absence is a documented *OrNull outcome",
      "Everything is parsed at a boundary; misses throw naming what was looked for and where",
    ],
    id: "not_found_throws",
    instructions:
      'Judge the file against "A function that looks something up must throw when it cannot" in AGENTS.md — never return null, "", 0, -1, or [] as a "not found" stand-in, unless absence is a genuinely expected outcome the caller branches on (then the *OrNull suffix and a comment). Penalise helpers that iterate looking for a value and fall off the end returning a stand-in, and unchecked `!`/`as` claims on data not checked against a shape. `nonnull_assertions` and `as_casts` list where the code claims a shape without checking; parse-at-the-boundary (valibot, explicit checks that throw) is the wanted shape.',
    label: "Lookups throw, not stand-ins",
    weight: 3,
  },
  {
    criteria: [
      "Several guards defend states the application says are impossible",
      "One guard hides a system-wide failure behind a fallback branch",
      "Guards sit only on failures that genuinely occur in normal operation",
      "Every branch is reachable in normal operation; impossible states raise loudly",
    ],
    id: "no_impossible_guards",
    instructions:
      'Judge the file against "Do not defend against the impossible" in AGENTS.md: no fallbacks, placeholders, or try/catch for failures that can only happen when a foundational system is already broken (a key that will not decrypt, a database that has vanished, an invariant the app guarantees). Such branches are unreachable in any state a request can reach, so they only hide system-wide failure behind an untestable arm. Penalise guards for states the application says are impossible; an observed impossible state must raise as an error instead.',
    label: "No guards for impossible states",
    weight: 2,
  },
  {
    criteria: [
      "SELECT * or whole-table loads the caller does not need",
      "One query loads columns or rows the caller never reads",
      "Queries name their columns and stay bounded, with one wide cache read backing detail paths",
      "Every query names the columns its caller reads, and stays bounded",
    ],
    id: "sql_needed_columns",
    instructions:
      'Judge the SQL statements in `sql_statements` against "Select only needed columns" in AGENTS.md: list the columns the caller actually uses, never SELECT *, and prefer a bounded query (by id, by key, WHERE, LIMIT) over loading every row. A whole-table read is right only for an admin collection page or a backup, and even then it names its columns. Whole-row reads through the table reader (`read.one`, `read.many`) are a sanctioned mechanism, not a finding.',
    label: "SQL selects needed columns",
    requires: (facts) => facts.sql.length > 0,
    weight: 3,
  },
  {
    criteria: [
      "Multi-statement writes fire as independent calls, so partial failure corrupts state",
      "One multi-statement write misses its batch or transaction",
      "Writes share transactions correctly, with one shape that could simplify",
      "Every multi-statement write is one batch or one tight transaction, chosen by whether logic sits between the steps",
    ],
    id: "transaction_shape",
    instructions:
      'Judge the write paths against "Transactions and Batches" in AGENTS.md. `write_calls` lists, with lines, the batch, transaction, and execute calls, the table writes (insert, update, delete), and the helpers named for a write (setX, saveX, logX, and similar). Multiple statements known up front belong in one batch (executeBatch and friends), so a later failure undoes the earlier writes in one round-trip. Statements with logic between them belong in withTransaction. Penalise independent execute calls that write several rows without a shared transaction, transactions held open across expensive non-database work, and a batch of one where a single read would do.',
    label: "Batch or transaction per write",
    requires: withWriteCalls,
    weight: 3,
  },
  {
    criteria: [
      "Links render to targets that 404 or that the viewer's role cannot open",
      "One link lacks the permission gate its target enforces, or one target looks built wrong",
      "Links are gated on the same conditions their targets enforce",
      "Every rendered link keeps its promise for every role that can see the page",
    ],
    id: "dead_links",
    instructions:
      'Judge the links in `hrefs` against "Never render a dead or forbidden link" in AGENTS.md: a rendered link is a promise it works. Penalise hrefs whose target the page cannot guarantee (a route that does not exist, a path built from a value that can be empty), and links to admin surfaces rendered without the gating condition the target route enforces — where the viewer cannot follow, the page must show plain text or an indicator instead. Mark unknown-but-plausible routes lower only when the built URL cannot be checked from the page.',
    label: "No dead or forbidden links",
    requires: (facts) => facts.hrefs.length > 0,
    weight: 4,
  },
  {
    criteria: [
      "Most user-facing copy is hard-coded in the template",
      "One or two user-facing strings bypass the catalog",
      "Copy flows through t() and the catalog, with at most a pending baseline item",
      "Every user-facing string reaches the page through the message catalog",
    ],
    id: "hard_coded_copy",
    instructions:
      'Judge the template against "Simple Language — How We Talk To Users" in AGENTS.md: every string a user reads (labels, buttons, errors, warnings, headers, empty states) comes from the message catalog through t("key"), not from a hard-coded string in the template. A string built from parts, or a value computed in the page, is data rather than copy. Attribute values and aria labels are copy too. Do not penalise developer-facing content such as a debug value or a URL.',
    label: "Copy lives in the catalog",
    requires: showsCopy,
    weight: 4,
  },
  {
    criteria: [
      "Comments and copy use different words for the same on-screen thing",
      "One word drifts between its label and the comment that names it",
      "Words match the labels the site shows",
      "Every word a reader meets matches the label, and one word keeps one meaning throughout",
    ],
    id: "naming_matches_site",
    instructions:
      'Judge the template against "Name a thing the way the site names it" in AGENTS.md: a story, comment, or column calls a thing what its label on the screen calls it, and one word keeps one meaning through the file. Penalise names and comments that call the thing on screen by a different word than the copy does (saying "name" where the label says "Username"), and identifiers leaking into reader-facing comments. Do not penalise code identifiers themselves — only the words used in comments and copy.',
    label: "Names say what the site says",
    requires: showsCopy,
    weight: 2,
  },
  {
    criteria: [
      "Shapes repeat inline throughout, and exported functions state no return types",
      "Repeated anonymous shapes, or a new name for a concept a type already describes",
      "Boundaries carry named types; one-off shapes stay inline where they read better",
      "Every repeated shape has one name, and exported functions state their return types",
    ],
    id: "type_shapes",
    instructions:
      'Judge the file against "Use types where they remove noise" in AGENTS.md: named types or interfaces for repeated shapes, reuse of an existing type that already describes the facts, and no second vocabulary for one concept. Penalise sprawling anonymous intersections a small named type would carry, and one-off shapes easier to read inline. `missing_return_types` lists exported functions whose return type is never stated.',
    label: "Types remove noise",
    weight: 2,
  },
  {
    criteria: [
      "Positional results drift through the code as bare indexes",
      "One indexed result survives past the call that produced it",
      "Ordered results are destructured into domain names at the boundary",
      "Boundaries destructure and validate counts; every result keeps a domain name throughout",
    ],
    id: "boundary_names",
    instructions:
      'Judge the file against "Name positional results at the boundary" in AGENTS.md: when a library returns an ordered array of different results, destructure it into domain names as soon as it enters the code, and validate an unguaranteed count at that boundary. Penalise results[2] or rows[7] traced through later mapping code, and mixed destructure-then-index use.',
    label: "Positional results named",
    weight: 2,
  },
  {
    criteria: [
      "Several parallel blocks that differ only in a value or a name",
      "One clear merge a helper or curry would make",
      "At most one pair close enough to be worth a second look",
      "No parallel implementations inside the file",
    ],
    id: "duplication_in_file",
    instructions:
      'Judge the file against "Zero code duplication" in AGENTS.md, file-local part: two or more near-identical blocks inside this file that want a shared helper or a curry — two functions differing only in a value, a path, a field name, or a callback are one function that has not been given its parameter yet. Do not penalise differences that carry real meaning, or the import block. The whole-tree duplication gate (jscpd) runs elsewhere; score what a careful reader of this one file would merge.',
    label: "No parallel blocks in the file",
    weight: 3,
  },
  {
    criteria: [
      "Logic and IO are interleaved throughout; nothing is testable without the database",
      "One tangled function mixes decisions with reads and writes",
      "Mostly separated, with one function that would split cleanly",
      "Pure functions decide, thin shells move data; each part is testable alone",
    ],
    id: "pure_io_split",
    instructions:
      'Judge the file against "Pure, functional" in docs/designing-systems.md: data-in/data-out logic lives in its own functions or file, with the input and output code kept in a thin shell around it. Penalise decisions interleaved with fetches and writes so no rule can be tested without a database — the shape that forces every test to be an integration test.',
    label: "Pure logic split from IO",
    weight: 2,
  },
];
