# test-searcher

This project uses functional programming patterns from the `@chobble/js-toolkit`.

## Preferences

- **Use FP methods**: Prefer curried functional utilities from `#fp` over imperative loops
- **Use Bun**: This project uses Bun exclusively for running, testing, and package management
- **100% test coverage**: All code must have complete test coverage

## FP Imports

```javascript
import { pipe, filter, map, reduce, compact, unique } from "#fp";
```

### Common Patterns

```javascript
// Compose operations
const processItems = pipe(
  filter(item => item.active),
  map(item => item.name),
  unique
);

// Instead of forEach, use for...of or curried filter/map
for (const item of items) {
  // ...
}

// Instead of array spread in reduce, use reduce with mutation
const result = reduce((acc, item) => {
  acc.push(item.value);
  return acc;
}, [])(items);
```

### Available FP Functions

| Function | Purpose |
|----------|---------|
| `pipe(...fns)` | Compose functions left-to-right |
| `filter(pred)` | Curried array filter |
| `map(fn)` | Curried array map |
| `flatMap(fn)` | Curried array flatMap |
| `reduce(fn, init)` | Curried array reduce |
| `sort(cmp)` | Non-mutating sort |
| `sortBy(key)` | Sort by property/getter |
| `unique(arr)` | Remove duplicates |
| `uniqueBy(fn)` | Dedupe by key |
| `compact(arr)` | Remove falsy values |
| `pick(keys)` | Extract object keys |
| `memoize(fn)` | Cache function results |
| `groupBy(fn)` | Group array items |

## Scripts

- `bun test` - Run tests
- `bun run lint` - Check code with Biome
- `bun run lint:fix` - Fix lint issues
- `bun run cpd` - Check for duplicate code
- `bun run precommit` - Run all checks (lint, cpd, tests)

## Lint Rules

The Biome config enforces:
- `noForEach` - Use `for...of` or curried `filter`/`map`
- `noAccumulatingSpread` - Use reduce with mutation
- `noVar` - Use `const` (or `let` if needed)
- `noDoubleEquals` - Use `===`
- `maxComplexity: 7` - Break into smaller functions
