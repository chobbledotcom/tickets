# Unread fields

Reports exported fields that nothing reads. Run it with:

```bash
nix develop -c deno task unread-fields
```

The scan takes about a minute and prints a line per field. It reports; it does
not gate.

## Why the type checker

`BulkSendResult.failed` counted a bulk email send's refused recipients. No
production code read it, so the operator was told every message went. A text
search cannot find that: `.failed` appears on `RegistrationDelivery`, on a
webhook result, and inside the translation key `address_lookup.failed`. A name
match calls the dead field alive.

The scan asks TypeScript instead. It builds a program over `src`, `test`,
`scripts` and `cli`, translates the import map's `#` aliases into what the
compiler expects, and asks the language service who refers to each field. The
answer is per symbol, so the four other `failed` mentions do not count.

## Reads, not mentions

A field can be mentioned often and still never be read. Every mention writes it,
and nothing downstream looks. So the scan counts reads only:

| Mention                 | Counts as |
| ----------------------- | --------- |
| `total: number`         | write     |
| `{ total: 1 }`          | write     |
| `{ total }`             | write     |
| `row.total = 1`         | write     |
| `row.total`             | read      |
| `const { total } = row` | read      |

A field is reported when nothing reads it, or when only `test/` does. A field
its tests alone read is kept alive by the tests themselves, which is the same
thing wearing a disguise.

## What it cannot see

A field reached without naming it has no reference to find, so the scan calls it
unread. Three cases do that in this repository:

- A row written and read through the table machinery, where the column is named
  by a `dbKey` string rather than by the field.
- A shape that crosses a boundary as JSON. The reader is another program, or a
  person.
- A value matched structurally, as `toEqual` does with an object literal.

Each is a false positive, and a reader has to judge them. That is why the scan
reports rather than fails: the list is a place to start looking, not a verdict.
A field the scan misses is rarer, and needs a read the compiler cannot see, such
as one through `Object.keys` or a computed name.
