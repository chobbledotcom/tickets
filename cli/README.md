# Tickets CLI

A command-line client for the Tickets admin API, for agents and scripts.
Deno only. Run the commands inside `devenv shell`, which provides the pinned
Deno and `curl`.

## The contract

Every command answers with one JSON document and one exit code:

- **stdout**: exactly one JSON document, nothing else.
- **stderr** on failure: one JSON object, shaped
  `{"error":{"kind","status","message","fields"}}`. `status` is the HTTP
  status, or `null` when no server answered. `fields` names per-field body
  problems, or `null` when no field failed.
- **Exit codes**: `0` success. `2` bad command or arguments. `3` the body
  failed validation (the client-side check, or a server `400`). `4` not
  allowed (`401`/`403`). `5` not found (`404`). `6` server or network
  failure (a `5xx`, a curl failure, or a malformed reply).

There are no prompts. A missing site or key is an exit `2` usage error.

## Configuration

Set the site and the key as environment variables or in a repo-local `.env`
file:

```sh
API_HOSTNAME=https://tickets.example.com
API_KEY=your-admin-api-key
```

A `.env` file that names the site `BASE_URL` works as the host too.

## describe — the command list

`describe` prints, as JSON, every resource, every verb's body fields with
their types and requiredness, every child, and every custom route. All of it
is read from the typed table at `src/shared/admin-api-resources.ts`: a
resource the table adds reaches the CLI with no CLI change.

```sh
deno task cli:api describe
deno task cli:api describe listings
```

A body the table does not describe statically is reported as
`{"kind":"server"}`: the server owns its validation, and the CLI sends the
parsed JSON as it is. Today this covers the `groups` and `listings` writes,
whose fields the server checks against the live catalog.

## Commands

The first argument is the verb. The second is the resource. Write verbs take
the JSON body as the last argument, or `-` to read it from stdin.

```sh
deno task cli:api list listings
deno task cli:api get listings 1
deno task cli:api create holidays '{"name":"Christmas","start_date":"2025-12-25","end_date":"2025-12-26"}'
deno task cli:api update holidays 1 '{"name":"Christmas Eve"}'
deno task cli:api delete holidays 1 '{"confirm_identifier":"Christmas Eve"}'
```

A child write addresses the parent row and the child in the id argument:

```sh
deno task cli:api create attributes 1/options '{"text":"1-2 minutes"}'
deno task cli:api update attributes 1/options/2 '{"text":"2 minutes"}'
deno task cli:api delete attributes 1/options/2 '{"confirm_identifier":"2 minutes"}'
```

A resource's custom routes are verbs too, before the resource and the id:

```sh
deno task cli:api deactivate listings 5
deno task cli:api reactivate listings 5
deno task cli:api attendees listings 5
```

An unknown resource, verb, child, or argument answers exit `2` and names the
valid choices. Ids are whole numbers. A body that fails the table's schema
never leaves the machine: the answer is exit `3` with the per-field problems
in `error.fields`.

## Where the shapes live

`src/shared/admin-api-resources.ts` is the one table of admin API resources:
the URL paths, the labels, the response envelopes, and the declared body
schemas. The server routes, the typed client `src/shared/admin-api-client.ts`,
and this CLI all read it. Every success answer the CLI prints passed the
table's envelope schema. A non-2xx answer throws `AdminApiError`, and the CLI
maps its status to the exit code above.

Deletes are confirmed: every delete takes `{"confirm_identifier":"<the
resource's current name>"}`, and the answer is `{"status":"ok"}`.

## Markdown frontmatter importer

`cli/import-frontmatter.ts` fills a Tickets site from a directory of markdown
files whose frontmatter describes products: one attribute per filter-attribute
name, one option per distinct value, one group per category, and one listing
per product with the rental options as day-count prices. The listing id and
slug are written back into each file's frontmatter (`tickets_id`,
`tickets_slug`), so a later integration can address them.

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

The importer's stdout is one JSON report with the counts and the progress
lines. Its failures answer the same stderr JSON error shape. A local input or
environment failure (a catalog refusal, an unreadable file) exits `6` with
kind `"io"`. A refused request maps its HTTP status like the api command.
