# Unread fields

Reports exported fields that nothing reads. Run it with:

```bash
nix develop -c deno task unread-fields
```

The scan takes a few minutes. It prints a line per reported field, and it does
not gate. It reports about one exported field in seven. Most of those are the
false positives listed below, so the report is a place to start.

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

A field belongs to a shape that `src/` exports. All three spellings count,
because this repository uses all three:

```typescript
export interface Sum {
  total: number;
}
export type Report = { headline: string };
export class Badge {
  html = "";
}
```

An object type nested inside one counts too, because `report.nested.deep`
reaches it. A shape the file keeps to itself does not, and neither does a member
a class keeps to itself.

A shape also hands on the fields it takes from somewhere else. That means a base
it extends, an intersection, another type it simply names, or every arm of a
union. `StripeRefund = StripeRefundFields` names one type, and
`Success | Failure` names two. The scan looks at the fields of every arm. A
reader reaches the fields of one arm, after it narrows the value to that arm.
The arms are often types the file keeps to itself, so no other shape reports
them. A field written down in a library, such as the `toFixed` that `number`
carries, is not a field this repository exports.

## Reads, not mentions

A field can be mentioned often and still never be read. Every one of its
mentions can put a value in, and none take one out. So the scan sorts each
mention by the syntax around it, and counts the reads:

| Mention                      | Counts as |
| ---------------------------- | --------- |
| `total: number`              | write     |
| `{ total: 1 }`               | write     |
| `{ total }`                  | write     |
| `row.total = 1`              | write     |
| `<Meter total={1} />`        | write     |
| `{ total() {} }`             | write     |
| `get total()`                | write     |
| `delete row.total`           | write     |
| `Config["total"]`            | write     |
| `[...row.total] = src`       | write     |
| `row.total`                  | read      |
| `const { total } = row`      | read      |
| `({ total } = row)`          | read      |
| `class C extends r.total {}` | read      |

`const { total } = row` and `({ total } = row)` are the pair that catches people
out. Both take `row.total` out, but the second is built from the same nodes as
`{ total: 1 }`. The scan tells them apart by what the object literal around them
is for. An object literal on the left of an `=` is a pattern, and its members
read. The same literal anywhere else is a value, and its members write.

`delete row.total` and `Config["total"]` are not writes in the ordinary sense. A
delete takes the field away, and the second names the field to borrow its type.
Neither takes the value out, which is the only question the scan asks, so both
sit on the write side of it.

`class C extends r.total {}` is the odd one. The compiler counts the clause it
sits in as a type, but the program reads the field when it runs, to find the
class to build on. An interface's `extends`, and every `implements`, read
nothing.

Two ways of writing a field give it a namesake, and the compiler answers a
lookup for either name with both. `constructor(public total: number)` declares a
parameter beside the field. `{ total }` declares the field out of a local. The
parameter is only there inside the constructor, and the local is there for the
whole file. Inside that reach, only a mention that names a member reads the
field. `this.total` and `const { total } = row` name one. A plain `total` names
the namesake, and no value leaves the field.

The rule is about the syntax a mention sits in, never about the name alone. In
`({ value: row.total } = source)` the field `value` reads and `row.total`
writes. In `const s = { sum: total }` and `class S { sum = total }`, `total` is
the value rather than the name, so both read it.

A field is reported when nothing reads it, or when only a test does. `test/`
counts as tests, and so does `scripts/email-sandbox-e2e/`, which is a live
end-to-end harness. A field its tests alone read is kept alive by the tests
themselves, which is the same thing wearing a disguise.

## What it cannot see

A field reached without naming it has no reference to find, so the scan calls it
unread. Four cases do that in this repository:

- A field carried by a spread. `({ title, ...props }) => ({ ...props })` moves
  every other field of the shape, and names none of them. Six fields of
  `WarningDeleteProps` travel that way, and all six report as unread.
- A row written and read through the table machinery, where the column is named
  by a `dbKey` string rather than by the field.
- A shape that crosses a boundary as JSON. The reader is another program, or a
  person. The 17 fields of `PublicListing` are one response body, and every one
  of them reports as unread.
- A value matched structurally, as `toEqual` does with an object literal.

Each is a false positive, and a reader has to judge them. That is why the scan
reports rather than fails: the list is a place to start looking, not a verdict.
A field the scan misses is rarer. It needs a read the compiler cannot see, such
as one through `Object.keys` or a computed name. One kind of shape is missed
whole: `Intent = v.InferOutput<typeof IntentSchema>` names a type the compiler
cannot work out here, because the program does not resolve the bare `valibot`
import. 79 exported aliases under `src/` take their shape that way, and each
contributes no fields to the report.
