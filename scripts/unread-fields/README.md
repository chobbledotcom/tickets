# Unread fields

Reports exported fields that nothing reads. Run it with:

```bash
nix develop -c deno task unread-fields
```

The scan takes a few minutes and prints a line per reported field. It reports;
it does not gate. Roughly one exported field in seven is reported, and most of
those are the false positives below, so read the list as somewhere to start
looking.

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

## What counts as a shape

A field belongs to a shape that `src/` exports. Both spellings count, because
this repository uses both:

```typescript
export interface Sum {
  total: number;
}
export type Report = { headline: string };
```

An object type nested inside one counts too, because `report.nested.deep`
reaches it. A shape the file keeps to itself does not.

## Reads, not mentions

A field can be mentioned often and still never be read. Every mention writes it,
and nothing downstream looks. So the scan counts reads only:

| Mention                 | Counts as |
| ----------------------- | --------- |
| `total: number`         | write     |
| `{ total: 1 }`          | write     |
| `{ total }`             | write     |
| `row.total = 1`         | write     |
| `<Meter total={1} />`   | write     |
| `{ total() {} }`        | write     |
| `get total()`           | write     |
| `row.total`             | read      |
| `const { total } = row` | read      |
| `({ total } = row)`     | read      |

The last two lines are the pair that catches people out. Both take `row.total`
out, but the second is built from the same nodes as `{ total: 1 }`. The scan
tells them apart by what the object literal around them is for: a pattern on the
left of an `=` reads, and a value anywhere else writes.

A field is reported when nothing reads it, or when only `test/` does. A field
its tests alone read is kept alive by the tests themselves, which is the same
thing wearing a disguise.

## What it cannot see

A field reached without naming it has no reference to find, so the scan calls it
unread. Four cases do that in this repository:

- A field carried by a spread. `({ title, ...props }) => ({ ...props })` moves
  every other field of the shape without naming one of them, so the six fields
  of `WarningDeleteProps` that travel that way all report as unread. This is the
  most common false positive by a distance.
- A row written and read through the table machinery, where the column is named
  by a `dbKey` string rather than by the field.
- A shape that crosses a boundary as JSON. The reader is another program, or a
  person.
- A value matched structurally, as `toEqual` does with an object literal.

Each is a false positive, and a reader has to judge them. That is why the scan
reports rather than fails: the list is a place to start looking, not a verdict.
A field the scan misses is rarer, and needs a read the compiler cannot see, such
as one through `Object.keys` or a computed name.
