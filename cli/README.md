# Tickets CLI

Deno-only, `curl`-powered tools for the Tickets admin API. Run the commands
below inside `devenv shell`, which provides the pinned Deno and `curl`.

Rezi was evaluated from `https://github.com/RtlZeroMemory/Rezi/`. Its public
packages currently target Node/Bun and its terminal backend depends on the Node
package plus native bindings, so this directory keeps the app Deno-native while
following Rezi's screen/state/action style. If Rezi ships a Deno backend,
`cli/tui.ts` is the migration seam.

## Configuration

Set either environment variables or a repo-local `.env` file:

```sh
API_HOSTNAME=https://tickets.example.com
API_KEY=your-admin-api-key
```

If either value is missing, the TUI/API script prompts for it at startup.

## Human TUI

```sh
deno task cli:tui
```

The TUI supports `resource`, `list`, `get`, `create`, `update`, `delete`,
`help`, and `quit`. Requests are executed by spawning `curl`.

## Agent scripts

```sh
deno task cli:api list listings
deno task cli:api get listings 1
deno task cli:api create listings '{"name":"Demo","max_attendees":10}'
deno task cli:api update listings 1 '{"active":false}'
deno task cli:api delete listings 1 '{"confirm_identifier":"Demo"}'

deno task cli:api list groups
deno task cli:api create holidays '{"name":"Christmas","start_date":"2025-12-25","end_date":"2025-12-26"}'
```

## Resources

The resource names — `attributes`, `listings`, `groups`, and `holidays` —
mirror the admin JSON API exactly. `cli/resources.ts` is the single source of
truth: both the TUI and the agent script read from it, and
`test/integration/tooling/cli.test.ts` derives the expected set from the
server's `adminApiRoutes` and fails if the two ever diverge. Exposing a new
`/api/admin/:resource` family is therefore a one-line addition here.

A nested resource addresses the parent id and the subpath in the id argument:

```sh
deno task cli:api create attributes '{"name":"Game Length"}'
deno task cli:api create attributes 1/options '{"text":"1-2 minutes"}'
deno task cli:api update attributes 1/options/2 '{"text":"2 minutes"}'
deno task cli:api delete attributes 1/options/2 '{"confirm_identifier":"2 minutes"}'
```

## Markdown Frontmatter Importer

`cli/import-frontmatter.ts` fills a Tickets site from a directory of markdown
files whose frontmatter describes products: one attribute per filter-attribute
name, one option per distinct value, one group per category, and one listing
per product with the rental options as day-count prices. The listing id and
slug are written back into each file's frontmatter (`tickets_id`,
`tickets_slug`), so the future integration can address them.

```sh
deno task cli:import-frontmatter --plan --dir ../my-catalog # print what would happen, change nothing
deno task cli:import-frontmatter --dir ../my-catalog        # run against the configured site
```

The task reads the site from the repo `.env` (`API_HOSTNAME` or `BASE_URL`,
plus `API_KEY`). Pass the catalog directory with `--dir`. The expected shape
is `src/products/*.md` with `src/categories/*.md` beside it. Reruns are safe:
a product whose frontmatter carries a `tickets_id` is skipped, and
attributes, options, and groups are matched by name before anything is
created. A product whose title matches an existing listing is skipped until
you pass `--update`, which overwrites that listing with the catalog data. The
task targets the site the `.env` names — check it before you run.
