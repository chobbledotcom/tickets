# Hacker News Critique

_Imagining this repo was posted to Hacker News. These are the nitpicky comments it would receive._

---

**dang_appreciates_this** 3 hours ago

I see you reinvented React, Express, Jest, and half of fp-ts. Congratulations, you've built a ticket booking system that could also serve as a dissertation on "Why Not To Use Libraries." Genuinely curious: how many tickets has this sold?

---

**cryptoskeptic** 3 hours ago

> Hybrid RSA-OAEP + AES-256-GCM for attendee PII

You've built a 3-layer key hierarchy (DB_ENCRYPTION_KEY -> KEK -> DATA_KEY -> private key) for a *ticket booking system*. If someone's threat model requires this level of encryption, they probably shouldn't be using a single-file edge script on Bunny CDN. This is the kind of overengineering that makes the code harder to audit, not easier.

Also, your `constantTimeEqual` at `crypto.ts:14` leaks length via the early return on line 15-17:

```typescript
if (a.length !== b.length) {
    return false;  // timing leak right here
}
```

An attacker can distinguish "wrong length" from "wrong content" by timing this branch. For CSRF tokens and session tokens where lengths are fixed, this is fine. But the function name promises constant-time and it doesn't fully deliver.

And `deriveTokenKey` uses PBKDF2 with **1 iteration** (line 596). Yes, the session token is high-entropy, but at that point why use PBKDF2 at all? Just use HKDF. You're paying the conceptual overhead of PBKDF2 without any of its stretching benefit. This reads like someone who learned "always use PBKDF2 for key derivation" without understanding when it's the wrong tool.

**edit:** The hybrid decrypt cache (`boundedLru<string, string>(10_000)` at line 721) caches *plaintext PII in memory* with no TTL. Your private key cache has a 10-second TTL, but the decrypted names and email addresses? Cached forever until evicted by LRU pressure. If you're going to build this elaborate encryption scheme, punching a 10,000-entry hole in it is... a choice.

---

**fp_purist** 2 hours ago

The FP module is a cute reimplementation of things that already exist in every FP library. But let's talk about what you actually built:

`memoize` (fp/index.ts:147) uses `JSON.stringify` for cache keys. This means `memoize(fn)({a: 1, b: 2})` and `memoize(fn)({b: 2, a: 1})` produce *different cache keys* because `JSON.stringify` is not order-independent. It also blows up on circular references with no error handling. And there's no cache eviction - this is an unbounded memory leak wearing a trenchcoat.

`mapAsync` (line 310) runs sequentially, not in parallel. Fine if you're respecting DB connection limits, but the function name doesn't communicate this at all. Anyone reading `mapAsync(fetchUser)(userIds)` would reasonably expect `Promise.all` semantics. Call it `mapSerial` or `mapSequential`.

Your `boundedLru` (line 333) uses Map insertion order for LRU tracking. This is clever but *wrong*. When you `get` a key, you delete and re-insert it to move it to the end. This means `get()` is a *mutation*. A read operation that mutates state. In a module called `fp`. You see the irony.

The `pipe` function has 5 overloads plus a fallback (lines 10-35). TypeScript's type system can express arbitrary-length pipe with recursive conditional types. This approach silently loses type safety past 5 compositions.

Also, you have `compact` that removes falsy values including `0` and `""`. This will silently destroy valid data like `price: 0` or `note: ""`. This is the lodash footgun all over again.

---

**jsx_enjoyer** 2 hours ago

Your JSX runtime doesn't escape single quotes in attributes (jsx-runtime.ts:78-83). You escape `&`, `<`, `>`, `"` but not `'`. Any attribute rendered with single-quote delimiters (which your runtime doesn't use, but still) or any inline event handler that contains a single quote could be an XSS vector if the content is ever recontextualized.

More concerning: `[elemName: string]: HtmlAttributes` (line 69-71) means `<script>`, `<iframe>`, `<object>`, and `<embed>` are all valid JSX elements that TypeScript will happily accept. Your `Raw` component on line 163 bypasses all escaping. One careless `<Raw html={userInput} />` and your whole security model is gone. You've carefully built AES-256-GCM hybrid encryption, and then provided a convenient escape hatch called `Raw`.

The `Fragment` component (line 156) creates a new `SafeHtml` by calling `renderChild(children)`. But `renderChild` already returns a string. So you're allocating a `SafeHtml` wrapper just to... hold a string. For deeply nested component trees, this creates a lot of intermediate `SafeHtml` objects that exist only to be `.toString()`'d immediately.

---

**deno_user_actually** 2 hours ago

You wrote 617 lines of Jest compatibility layer (test-compat.ts) instead of just using Deno's native test API. `describe`/`it`/`expect` is a familiar API but you pay real costs:

1. `sanitizeOps: false` and `sanitizeResources: false` on every test (line 95-96). You've disabled Deno's two most useful test safety features — op leak detection and resource leak detection. You're explicitly telling Deno "don't check if my tests leak async operations or file handles." Why use Deno at all if you're going to disable its best features?

2. `beforeAll`/`afterAll` are defined (lines 121-132) but never wired up. They set properties on the context but `test()` only calls `beforeEach`/`afterEach`. This is dead code that silently does nothing when someone tries to use it.

3. The `toMatchObject` implementation (line 332-346) is broken for `not` — it catches the *assertion* error and swallows it, meaning `expect(obj).not.toMatchObject(partial)` passes even when it should fail, as long as *any* key doesn't match (not *all* keys).

4. `useFakeTimers()` (line 593) saves `realSetTimeout` but never uses it. You patch `Date.now` but not `setTimeout`/`setInterval`/`queueMicrotask`. Any code using `setTimeout` will still use real timers.

---

**database_person** 2 hours ago

Table names are interpolated directly into SQL strings (table.ts:171-183):

```typescript
const buildInsertSql = (name: string, columns: string[]): string => {
  return `INSERT INTO ${name} (${columns.join(", ")}) ...`;
};
```

Yes, `name` comes from your own code, not user input. But this is a SQL injection waiting to happen if anyone ever refactors carelessly. The column names are also interpolated. Parameterized queries for values but string interpolation for identifiers — this is the "we control it so it's fine" school of security.

Also, `findAll` (table.ts:332) does `SELECT *` with no pagination. For a table with 10,000 encrypted attendees, this will decrypt *all of them* sequentially via `mapAsync(fromDb)`. Each row hits `hybridDecrypt` which does RSA + AES. Hope your edge function has a generous timeout.

`update` (table.ts:288) does a write, then immediately does a `findById` read (line 311) to return the updated row. That's two round trips to a potentially-remote Turso database for every update. In the admin panel, editing an event name costs you a write + a full decrypt of every column.

---

**routing_pedant** 1 hour ago

Your route matching in `routes/index.ts` is a sequential chain of `??` operators (lines 155-164):

```typescript
(await routeHome(request, path, method, server)) ??
(await routePublicPages(request, path, method, server)) ??
(await routeAdminPath(request, path, method, server)) ??
...
```

Every request awaits each route handler *sequentially* until one matches. A request to `/join/abc` has to go through `routeHome`, `routePublicPages`, `routeAdminPath`, `routeTicketPath`, `routeTicketViewPath`, `routeCheckinPath`, `routeImagePath`, and `routePaymentPath` — all returning null — before reaching `routeJoinPath`. Each of those involves a `matchesPrefix` check which is cheap, but the `await` on each is not free.

You have a perfectly good compiled-regex router in `router.ts`. Why isn't the top-level routing using it? The `createLazyRoute` pattern breaks the router's efficiency by making every route group its own isolated router.

Also, the type-level `InferParamType` (router.ts:24-27) silently converts anything ending in `Id` to `number`. So if someone adds a route `:providerId` where provider IDs are UUIDs, it'll silently parse `"abc-def"` as `NaN`. No runtime error, just a NaN propagating through your system.

---

**edge_computing_skeptic** 1 hour ago

You're building for Bunny Edge Scripting, which has a 10MB bundle limit. Your build script checks for this (build-edge.ts). But you're bundling `stripe@^17.0.0` (the full Stripe SDK) and `@libsql/client` (a Turso database client) into a single edge script. The Stripe SDK alone is enormous — you're using maybe 5% of it for checkout sessions and webhooks.

The Node.js compatibility banner in build-edge.ts is telling:

```javascript
import * as process from "node:process";
import { Buffer } from "node:buffer";
globalThis.process ??= process;
globalThis.Buffer ??= Buffer;
```

You're polyfilling Node.js globals in an edge runtime. This is the "run everywhere" dream that always ends in "debug everywhere."

The `EDGE_SUBPATHS` map forces `@libsql/client` to use its `/web` build. Turso's web build uses HTTP requests instead of WebSocket connections. Every database query is a separate HTTP round-trip. For an admin page that loads an event + all its attendees + decrypts them, that could be dozens of sequential HTTP requests from your edge function to Turso.

---

**async_local_storage_hater** 1 hour ago

`AsyncLocalStorage` from `node:async_hooks` for request ID correlation (logger.ts:15). In an edge runtime. This is a Node.js API that Deno supports for compatibility but that Bunny Edge Scripting may or may not handle correctly with their Deno-based runtime. You're depending on a Node.js compatibility shim inside a non-Node runtime that's pretending to be a browser (`platform: "browser"` in esbuild) while importing Node built-ins. This is fine.

---

**license_lawyer** 45 minutes ago

AGPLv3 for a ticket booking system. So if I self-host this and my *customers* (ticket buyers) interact with it over the network, I'm required to offer them the source code. For a system whose entire security model is "we encrypt everything so even database access doesn't expose PII," making the source available is... a philosophical choice. (Yes, I know security through obscurity isn't real security, but still.)

Also "Hosted instances available at tix.chobble.com for £50/year, no tiers" — the AGPLv3 means anyone can take this, host it themselves, and compete with you. The license is doing the opposite of protecting your business model.

---

**55k_lines_guy** 30 minutes ago

56,621 lines of TypeScript across 194 files for a ticket booking system. That's roughly the size of a small compiler. The crypto module alone is 847 lines. The test compatibility layer is 617 lines. The FP utilities are 435 lines. The build script is 275 lines.

You've written more infrastructure code than application code. The custom JSX runtime, the Jest compat layer, the FP library, the router, the table abstraction, the build pipeline, the encryption stack — these are all "build the tools to build the thing" rather than "build the thing."

A Django/Rails equivalent would be ~2,000 lines plus a database migration. You'd get battle-tested auth, form handling, CSRF, ORM, session management, and template rendering for free. Instead, you hand-rolled all of it. The result is impressive engineering and terrible ROI.

---

**actually_a_fan** 15 minutes ago

Hot take: this is exactly the kind of project HN should celebrate. Single-person codebase, no VC money, privacy-first design, self-hostable, AGPLv3, runs on edge infrastructure, 100% test coverage. Yes, it reinvents wheels. But those wheels are *well-engineered* wheels with clear code, comprehensive tests, and thoughtful security. The author clearly understands cryptography, web security, and TypeScript at a deep level. The fact that they chose to build their own tools rather than depend on an npm ecosystem that breaks every 6 months is a feature, not a bug. I'd trust this with my ticket sales over any Eventbrite knockoff built on Next.js with 400 transitive dependencies.
