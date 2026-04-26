# Repository Structure Reference

This document describes the **current layout** after the structure migration.

## Current top-level `src/` layout

```text
src/
  app/                  # runtime entrypoints
    index.ts            # local/server bootstrap
    edge.ts             # Bunny edge bootstrap

  ui/                   # presentation layer
    client/             # browser-side scripts and admin UI interactions
    static/             # static assets + generated browser bundles
    templates/          # TSX templates for public/admin/email pages

  routes/               # HTTP routing and route handlers
  lib/                  # shared/domain logic (in-progress migration target)
  docs/                 # API and feature documentation endpoints
  test-utils/           # shared test helpers/factories/mocks
  fp.ts                 # functional primitives
  test-utils.ts         # test utils barrel
  static.d.ts           # static module declarations
```

## Import and build conventions

- Use `#templates/*` for UI template imports (mapped to `src/ui/templates/*`).
- Use `#static/*` for static asset references (mapped to `src/ui/static/*`).
- Static builds now read from `src/ui/client` and emit to `src/ui/static`.
- `src/index.ts` and `src/edge.ts` remain as compatibility entrypoints that delegate to `src/app/*`.

## Migration status

Completed in this phase:

- ✅ Introduced `src/app` and moved runtime bootstraps there.
- ✅ Introduced `src/ui` and moved `client`, `static`, and `templates` under it.
- ✅ Updated import-map aliases and build/tooling scripts for the new paths.

Still in progress:

- `src/lib` and `src/routes` are still in their previous structure and can be migrated incrementally by feature slices.

## Contributor guidance

- New browser code should go in `src/ui/client`.
- New reusable templates should go in `src/ui/templates`.
- New static assets should go in `src/ui/static`.
- New entry/runtime wiring should live in `src/app`.
