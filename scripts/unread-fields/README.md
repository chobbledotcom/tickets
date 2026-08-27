# Unread fields

Reports exported fields that nothing reads. Run it with:

```bash
nix develop -c deno task unread-fields
```

The scan takes a few minutes. It prints a line per reported field, and it does
not gate. It reports about one exported field in eight. Most of those are the
false positives listed below, so the report is a place to start.

## Why the type checker

`BulkSendResult.failed` counted a bulk email send's refused recipients. No
production code read it, so the operator was told every message went. A text
search cannot find that: `.failed` appears on `RegistrationDelivery`, on a
webhook result, and inside the translation key `address_lookup.failed`. A name
match calls the dead field alive.

The scan asks TypeScript instead. It builds a program over `src`, and over
`test`, `scripts`, `cli` and `e2e-payments/src` for the readers they hold. It
translates the import map's `#` aliases into what the compiler expects, and asks
the language service who refers to each field. The answer is per symbol, so the
four other `failed` mentions do not count.

It asks with the options the repository asks for, out of `deno.json`. That
matters more than it looks. Under `strict`, an `if (!result.ok)` narrows a
result to its failure arm, and the read of `result.error` inside belongs to the
field that arm declares. Without it the compiler narrows differently and the
read lands elsewhere, so the field looks dead. 46 fields reported as never read
under the wrong options, and every one of them is read by production. Almost all
were called `error`, `reason`, `response` or `detail`.

The report is about `src`, so a checkout without it fails rather than reports. A
run that says every one of no fields is read reads like a clean bill.

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
reaches it. A generic that holds one hands it on. So `Array<{ id: number }>` and
`Record<string, { id: number }>` both count. `Extract<Row, { kind: "one" }>` is
different. Its second argument says which arms of `Row` to keep. It is a filter,
and no value of the shape has a field of it. `Exclude` works the same way.

A conditional type is the same idea. `true extends true ? A : B` answers with
`A`, so no value of it holds a field of `B`. A conditional that waits on a type
parameter has no answer yet, and both arms count.

A shape the file keeps to itself does not count. Neither does a member a class
keeps to itself, nor a type written inside one. A `private` on a constructor
parameter is the one exception. The word hides the field, and the constructor
stays everyone's to call, so the type a caller supplies still counts. A static
block holds only code, so a type declared inside one does not count either.

`C.made` and `held.made` are two fields. A static belongs to the class object,
and the report calls that object `typeof C`, which is what TypeScript calls it.
One line for both would call a field on a value read because the class side is.

A field is named in four ways, and all four reach the same member. `total`,
`"quoted-name"`, `1`, and `["quoted-name"]` are each a name the compiler answers
a lookup for. A name a variable works out stays out, because the variable is not
the field. A `#private` name stays out too, because nobody outside can reach it.

A `declare global` block does not count either. It adds its shapes to the global
scope rather than to what the file exports. The one in
`src/shared/jsx/jsx-runtime.ts` holds the JSX contract, and the compiler reads
those fields rather than any code here, so the scan would call them unread.

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
| `{ ["total"]: 1 }`           | write     |
| `row.total = 1`              | write     |
| `<Meter total={1} />`        | write     |
| `{ total() {} }`             | write     |
| `get total()`                | write     |
| `delete row.total`           | write     |
| `Config["total"]`            | write     |
| `[...row.total] = src`       | write     |
| `row.total! = 1`             | write     |
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

A name in brackets can borrow a type the same way.
`interface Uses {
[Registry.key]: string }` works its name out while the file
compiles, and nothing evaluates it when the program runs. So does a member of a
class that is only described: a `declare class`, one inside a
`declare
namespace`, or any declaration in a `.d.ts` file. An object literal
works its key out as it runs. A real class works its member names out as its
declaration runs, even where nothing ever makes one, so both read.

`{ ["total"]: 1 }` supplies the field exactly as `{ total: 1 }` does, and
`({ ["total"]: held } = row)` takes it out exactly as `({ total: held } = row)`
does. The brackets change nothing, so the scan puts its question to the brackets
and to the thing that holds them.

`row.total! = 1` is the wrapper case. Five wrappers can sit between the field
and the `=`: parentheses, a `!`, an `as`, a `satisfies`, and an angle-bracket
assertion written as `(<number> row.total) = 1`. None of them changes what the
program does, so all five write the field. A delete allows only parentheses,
because its operand must be a property reference.

`class C extends r.total {}` is the odd one. The compiler counts the clause it
sits in as a type. The program still reads the field when it runs, to find the
class to build on. An interface's `extends`, and every `implements`, read
nothing. Neither does a class that is only described. A `declare class`, a class
inside a `declare namespace`, and every declaration in a `.d.ts` file describe a
class that exists somewhere else.

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
counts as tests, and so do `scripts/email-sandbox-e2e/` and `e2e-payments/`,
which are live end-to-end harnesses. A field only its tests read is kept alive
by those tests. No production code needs it, so it is dead under another name.

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

A line names the field the way code reaches it. A plain word goes after a dot,
as `Sum.total`. Any other name takes brackets and quotes, as `Row["has.a.dot"]`,
so a name that holds a dot cannot read like a path. A member with no name of its
own gets the way a reader reaches through it instead: `Callable["()"]` for a
call signature, `Constructable["new ()"]` for a construct signature, and
`Bag["[]"]` for an index signature.

Each is a false positive, and a reader has to judge them. That is why the scan
reports rather than fails: the list is a place to start looking, not a verdict.
A field the scan misses is rarer. It needs a read the compiler cannot see, such
as one through `Object.keys` or a computed name. One kind of shape is missed
whole: `Intent = v.InferOutput<typeof IntentSchema>` names a type the compiler
cannot work out here, because the program does not resolve the bare `valibot`
import. 77 exported aliases under `src/` take their shape that way, and each
contributes no fields to the report.
