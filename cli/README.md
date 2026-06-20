# Tickets CLI

Deno-only, `curl`-powered tools for the Tickets admin API.

Rezi was evaluated from `https://github.com/RtlZeroMemory/Rezi/`. Its public
packages currently target Node/Bun and its terminal backend depends on the
Node package plus native bindings, so this directory keeps the app Deno-native
while following Rezi's screen/state/action style. If Rezi ships a Deno backend,
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
mise exec -- deno task cli:tui
```

The TUI supports `resource`, `list`, `get`, `create`, `update`, `delete`,
`help`, and `quit`. Requests are executed by spawning `curl`.

## Agent scripts

```sh
mise exec -- deno task cli:api list listings
mise exec -- deno task cli:api get listings 1
mise exec -- deno task cli:api create listings '{"name":"Demo","max_attendees":10}'
mise exec -- deno task cli:api update listings 1 '{"active":false}'
mise exec -- deno task cli:api delete listings 1 '{"confirm_identifier":"Demo"}'

mise exec -- deno task cli:api list groups
mise exec -- deno task cli:api create holidays '{"name":"Christmas","start_date":"2025-12-25","end_date":"2025-12-26"}'
```

## Resources

The resource names — `listings`, `groups`, and `holidays` — mirror the admin
JSON API exactly. `cli/resources.ts` is the single source of truth: both the
TUI and the agent script read from it, and `test/lib/cli.test.ts` derives the
expected set from the server's `adminApiRoutes` and fails if the two ever
diverge. Exposing a new `/api/admin/:resource` family is therefore a one-line
addition here.
