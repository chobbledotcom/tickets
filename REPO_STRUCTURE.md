# Repository Structure Reference

This document describes the **current** structure.

## `src/` layout

```text
src/
  app/                     # runtime entrypoints
    index.ts               # local/server bootstrap
    edge.ts                # Bunny edge bootstrap

  features/
    admin/
    public/
    ...                    # HTTP routing and route handlers grouped by feature

  shared/                  # reusable/server-side modules
    db/
    rest/
    jsx/
    crypto/
    columns/
    merge/
    wallets/
    ...

  ui/                      # presentation layer
    client/                # browser-side scripts
    static/                # static assets (+ generated bundles)
    templates/             # TSX templates (public/admin/email)

  docs/                    # API/doc endpoint content
  test-utils/              # shared test helpers/factories/mocks
  fp.ts                    # functional primitives
  test-utils.ts            # test utils barrel
  static.d.ts              # static module declarations
```

## Import conventions

- `#routes/*` resolves to `src/features/*`.
- `#lib/*` resolves to `src/shared/*` (kept for compatibility and incremental refactors).
- `#templates/*` resolves to `src/ui/templates/*`.
- `#static/*` resolves to `src/ui/static/*`.
- `#jsx/*` resolves to `src/shared/jsx/*`.

## Build/tooling conventions

- Client bundle inputs live in `src/ui/client` and outputs are emitted to `src/ui/static`.
- Runtime entry wrappers remain at `src/index.ts` and `src/edge.ts`, delegating to `src/app/*`.
- Static file route handlers read from `src/ui/static`.

## Contributor guidance

- Put new route handlers in the relevant `src/features/*` module.
- Put shared server/domain logic in `src/shared`.
- Put browser scripts in `src/ui/client`.
- Put templates in `src/ui/templates`.
- Put static assets in `src/ui/static`.
