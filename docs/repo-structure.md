# Repository Structure Reference

This document describes the current structure.

## `src/` layout

```text
src/
  features/
    admin/
    api/
    public/
    tickets/
    wallet/
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
  index.ts                 # local/server bootstrap
  edge.ts                  # Bunny edge bootstrap
  fp.ts                    # functional primitives
  static.d.ts              # static module declarations
```

## Admin routes and paths

`src/shared/admin-surface/areas.ts` declares admin URL patterns, audiences, and
read-only exceptions.

- Use `adminRedirect(endpoint, params, message, succeeded, opts?)` for a
  response to a known admin endpoint. Static endpoints take `{}` as `params`.
- Use `adminPattern` for static URL values and route table keys.
- Use `adminPath` for link and form URLs with named parameters.
- Use an entity page's `.path` when its tab rules determine the destination.

`adminRedirect` uses the same flash cookies, return URL precedence, and form
anchors as `redirect`. Keep `redirect` for URLs that query, tab, or dynamic
return helpers already resolve.

Generated CRUD handlers read optional `afterSave` overrides from their routes.
The create override belongs on the collection route, because the form posts
there, not to `/new`. Without an override, a save returns to the collection
list.

The read-only guard reads `readOnlyWrite` from admin routes. Its public
exceptions live in `src/features/app/read-only-safe-routes.ts`. This table
stays separate from the lazy public handlers.

## Import conventions

- `#routes/*` resolves to `src/features/*`.
- `#shared/*` resolves to `src/shared/*`.
- `#templates/*` resolves to `src/ui/templates/*`.
- `#static/*` resolves to `src/ui/static/*`.
- `#jsx/*` resolves to `src/shared/jsx/*`.

## Build/tooling conventions

- Client bundle inputs live in `src/ui/client` and outputs are emitted to
  `src/ui/static`.
- Runtime entrypoints are `src/index.ts` and `src/edge.ts`.
- Static file route handlers read from `src/ui/static`.

## Contributor guidance

- Put new route handlers in the relevant `src/features/*` module.
- Put shared server/domain logic in `src/shared`.
- Put browser scripts in `src/ui/client`.
- Put templates in `src/ui/templates`.
- Put static assets in `src/ui/static`.
