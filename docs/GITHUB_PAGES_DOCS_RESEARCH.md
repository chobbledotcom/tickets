# GitHub Pages Documentation Site — Research & Recommendations

## Goal

Create a `docs/` folder that publishes to GitHub Pages, documenting the features of the Chobble Tickets platform in a way that is **highly integrated with the `src/` directory** — meaning docs can reference source code, auto-generate API references from TypeScript types, link to source files, and stay in sync as the codebase evolves.

## Current State

- `docs/` currently contains only an `index.html` embed demo
- The project is Deno/TypeScript with `deno.json` import maps (`#lib/`, `#fp`, etc.)
- 80+ source files across `src/lib/`, `src/routes/`, `src/templates/`
- Existing inline documentation: JSDoc comments, type definitions in `src/lib/types.ts`, API examples in `src/lib/api-example.ts`, webhook examples in `src/lib/webhook-example.ts`
- An admin guide already exists at `src/routes/admin/guide.ts`

---

## Options Evaluated

### 1. VitePress (Recommended)

**What it is:** Vue-powered static site generator purpose-built for documentation. Used by Vue, Vite, Vitest, Pinia, and many other projects.

**Source integration:**
- Markdown files can include code snippets from source files via `<<< @/src/lib/types.ts{typescript}` syntax (file includes with line highlighting)
- Supports `{line-numbers}`, line highlighting, region markers (`// #region` / `// #endregion`) to embed specific sections
- Can import `.ts` files directly in custom Vue components for live rendering
- Code groups for showing multiple related files side-by-side
- Built-in search (local or Algolia)

**GitHub Pages:** First-class support. Has an official deployment guide and GitHub Actions workflow.

**Deno compatibility:** VitePress runs on Node, but only for building docs — it doesn't need to run the Deno project. Source file includes work via filesystem paths.

**Setup effort:** Low-medium. `npm init vitepress` scaffolds everything. Markdown-first with optional Vue components.

**Maintenance:** Low. Markdown files with source includes auto-update when source changes (at build time). Community is large and active.

**Key strengths for this project:**
- File includes (`<<<`) make it trivial to embed source code that stays in sync
- Region markers let you embed specific sections of `types.ts`, `crypto.ts`, etc.
- Sidebar auto-generation from folder structure
- Built-in dark mode, mobile responsive
- Fast build times
- Can create custom components that parse TypeScript types

**Limitations:**
- No auto-generated API docs from TypeScript types (need manual includes or a plugin)
- Runs on Node (separate from Deno toolchain)

---

### 2. Starlight (Astro)

**What it is:** Astro-based documentation framework. Used by Astro itself, Cloudflare, Sentry.

**Source integration:**
- Can import and render code from source files using Astro components
- `expressive-code` integration for advanced code blocks (diffs, line highlighting, file names)
- Supports MDX — can use custom Astro components in docs
- Plugin ecosystem for auto-linking, API reference generation

**GitHub Pages:** Excellent support. Official Astro deployment guide for GitHub Pages.

**Deno compatibility:** Astro is Node-based. Same situation as VitePress — builds docs separately from the Deno project.

**Setup effort:** Medium. More flexible than VitePress but slightly more configuration. `npm create astro@latest -- --template starlight`

**Maintenance:** Low-medium. Active development, backed by the Astro team.

**Key strengths:**
- Content collections with schema validation (frontmatter types checked at build time)
- i18n built-in
- Component islands — can embed interactive widgets in docs
- Excellent TypeScript support in the docs framework itself
- `starlight-typedoc` plugin exists for auto-generating API docs from TypeScript

**Limitations:**
- Heavier framework than VitePress
- File includes require custom Astro components (not built-in like VitePress `<<<`)
- Slightly steeper learning curve

---

### 3. Lume (Deno-native)

**What it is:** Static site generator built for Deno. The only option that runs natively in the same runtime as the project.

**Source integration:**
- Can write custom plugins in Deno that import from `src/` using the same `deno.json` import maps
- Could directly `import type { Event } from "#lib/types"` in build scripts
- Custom processors can extract JSDoc, parse TypeScript AST, generate docs
- Template engines: Nunjucks, Pug, Eta, JSX, MDX, Markdown

**GitHub Pages:** Works fine — generates static HTML. Needs a custom GitHub Actions workflow (no official one, but straightforward).

**Deno compatibility:** Perfect — it IS Deno. Shares the project's runtime, import maps, and TypeScript config.

**Setup effort:** Medium-high. Less batteries-included than VitePress/Starlight for docs specifically. Would need more custom work for features like search, sidebar navigation, and API reference.

**Maintenance:** Medium. Smaller community than VitePress/Starlight. Deno ecosystem is growing but less mature for docs tooling.

**Key strengths:**
- **Deepest possible integration** — can literally import project source code in build scripts
- Same `deno.json` import maps, same TypeScript config
- Could auto-generate docs by walking the project's module graph
- No Node dependency needed
- Lightweight and fast

**Limitations:**
- No built-in docs theme (would need to build or adapt one)
- Smaller plugin ecosystem
- Search, navigation, and other docs features need manual setup
- Less mature than Node-based alternatives

---

### 4. TypeDoc + Static Site

**What it is:** Auto-generates API documentation from TypeScript source code and JSDoc comments.

**Source integration:**
- **Maximum auto-generation** — reads all exported types, functions, interfaces, classes
- Generates navigable API reference from `src/lib/types.ts`, `src/lib/crypto.ts`, etc.
- Links to source code on GitHub
- Supports `@link`, `@example`, `@param`, `@returns` JSDoc tags

**GitHub Pages:** Outputs static HTML. Works with any GitHub Pages setup.

**Deno compatibility:** TypeDoc is Node-based. Deno-specific import maps (`#lib/`, `#fp`) would need configuration via `typedoc.json` path mapping. May require a `tsconfig.json` that maps the Deno aliases.

**Setup effort:** Low for API reference. High if you want narrative docs (guides, tutorials) — TypeDoc focuses on API reference, not prose.

**Maintenance:** Very low for API docs — they regenerate automatically. But you'd need a separate solution for guides/tutorials.

**Key strengths:**
- Zero-effort API docs from existing TypeScript types
- Auto-generates from code changes — always in sync
- Good for documenting `types.ts`, database schemas, route definitions

**Limitations:**
- Only generates API reference, not narrative documentation
- Deno import map resolution needs workarounds
- Output looks like API docs, not a documentation site
- Best used as a complement to another tool, not standalone

---

### 5. Docusaurus

**What it is:** React-based documentation framework by Meta. Powers React, Jest, and many OSS docs.

**Source integration:**
- MDX support for embedding React components
- Code blocks with line highlighting, live editors
- Can create custom components that read/display source files
- Plugin for API docs via TypeDoc integration (`docusaurus-plugin-typedoc`)

**GitHub Pages:** First-class support with official deployment command.

**Setup effort:** Medium. More opinionated than Starlight, heavier than VitePress.

**Maintenance:** Low. Large community, backed by Meta.

**Key strengths:**
- Versioned docs (useful if the platform has releases)
- Blog built-in
- Algolia DocSearch integration
- Very mature ecosystem

**Limitations:**
- Heaviest framework of the options (React SSR, webpack/rspack)
- Slower builds than VitePress
- No built-in file include syntax — need custom plugins
- Overkill for a project this size

---

### 6. mdBook

**What it is:** Rust-based, minimal markdown book generator. Used by Rust documentation.

**Source integration:**
- `{{#include ../src/lib/types.ts:anchor}}` syntax for embedding source code sections
- Anchor-based includes work with `// ANCHOR: name` / `// ANCHOR_END: name` markers
- Simple but effective for code embedding

**GitHub Pages:** Generates static HTML. Works with any deployment.

**Setup effort:** Very low. Single binary, minimal config.

**Maintenance:** Very low. Stable, minimal dependencies.

**Key strengths:**
- Extremely simple
- File includes with anchors
- Fast builds
- No JavaScript runtime needed for building

**Limitations:**
- No TypeScript-aware features
- No component system — pure markdown only
- Basic search (built-in JS search)
- No auto-generated API docs
- Minimal theming

---

### 7. Plain GitHub Pages (Jekyll)

**Source integration:** Minimal. Can link to source files on GitHub but no file includes or code generation.

**Verdict:** Too basic for "highly integrated with src dir" requirement. Skip.

---

### 8. Fumadocs (Next.js)

**Source integration:** Good MDX support, TypeDoc integration available.

**Verdict:** Requires Next.js — far too heavy for this project's docs. Skip.

---

### 9. Fresh (Deno)

**What it is:** Deno-native web framework (by Deno team).

**Verdict:** Full web framework, not a docs generator. Would require building everything from scratch. Not appropriate for documentation.

---

### 10. Custom Script Approach

**What it is:** Hand-rolled Deno scripts that extract JSDoc/types from source and generate markdown, then use a minimal static site generator or plain HTML.

**Source integration:** Maximum — you control exactly what gets extracted and how.

**Verdict:** High initial effort, high maintenance burden. Only makes sense if the project has very specific needs not met by existing tools.

---

## Comparison Matrix

| Criteria | VitePress | Starlight | Lume | TypeDoc | Docusaurus | mdBook |
|---|---|---|---|---|---|---|
| **Source code embedding** | Excellent (`<<<`) | Good (components) | Excellent (Deno imports) | Auto-generated | Good (MDX) | Good (anchors) |
| **Auto API docs from TS** | Plugin needed | `starlight-typedoc` | Custom scripts | Built-in | Plugin exists | No |
| **GitHub Pages** | First-class | First-class | Manual workflow | Static output | First-class | Static output |
| **Deno compatibility** | Node (separate) | Node (separate) | Native Deno | Node (needs config) | Node (separate) | Rust (separate) |
| **Setup effort** | Low | Low-Medium | Medium-High | Low (API only) | Medium | Very Low |
| **Maintenance** | Low | Low | Medium | Very Low | Low | Very Low |
| **Narrative docs** | Excellent | Excellent | Good | Poor | Excellent | Good |
| **Search** | Built-in | Built-in | Manual | Built-in | Algolia/built-in | Basic built-in |
| **Community size** | Very large | Large | Small | Large | Very large | Large |
| **Bundle/build weight** | Light | Medium | Light | Light | Heavy | Very light |

---

## The Deno Compatibility Problem

A critical factor: **TypeDoc** (which powers auto-generated API docs for VitePress, Starlight, and Docusaurus) is Node-based and has [documented issues](https://github.com/denoland/std/issues/321) with Deno-style imports. This project uses:
- `#fp`, `#lib/` import aliases (from `deno.json` import maps)
- `npm:` and `jsr:` specifiers
- `.ts` extension imports

TypeDoc can't resolve these without a wrapper `tsconfig.json` with manual path mappings, and even then some Deno idioms may break.

**`deno doc`** is the only tool that natively understands this project's full import structure. `deno doc --json` outputs structured API data, and `deno doc --html` generates a complete static reference site — both with zero configuration.

---

## Recommendations

### Option A: Lume + `deno doc` (Deepest Integration)

**Why:** The only fully Deno-native approach. No Node.js needed. `deno doc` natively resolves `#fp`, `#lib/`, `npm:`, `jsr:` — zero compatibility issues. Lume is what Deno's own documentation site uses.

**Integration approach:**
- `deno doc --json` extracts API data that a custom Lume plugin transforms into reference pages
- Lume build scripts can `import type { Event } from "#lib/types"` directly
- Narrative docs in Markdown alongside auto-generated API reference
- Shares the project's `deno.json` import maps and TypeScript config

**Choose this if:** Deno-native tooling matters, you want the deepest possible source integration, and you're comfortable writing a Lume plugin to transform `deno doc` JSON output.

```
docs/
├── _config.ts             # Lume config
├── _includes/
│   └── layout.njk         # Base layout template
├── index.md               # Landing page
├── guide/
│   ├── getting-started.md
│   ├── events.md
│   ├── booking.md
│   ├── payments.md
│   ├── encryption.md
│   └── api.md
├── reference/             # Auto-generated from deno doc --json
│   ├── types.md
│   ├── routes.md
│   └── database.md
├── _plugins/
│   └── deno-doc.ts        # Custom plugin: runs deno doc, generates pages
└── deno.json              # Lume-specific Deno config
```

---

### Option B: VitePress (Best Batteries-Included)

**Why:** Best balance of ease-of-setup and source integration for narrative docs. File includes (`<<<`) embed actual source code sections that stay in sync. Huge community, built-in search, dark mode, responsive sidebar.

**Integration approach:**
- `<<<` file includes embed source code directly: `<<< @/../src/lib/types.ts#event-types {typescript}`
- `// #region` / `// #endregion` markers in source files for surgical embedding
- Auto-generated API docs possible via `vitepress-plugin-typedoc` (but requires `tsconfig.json` path mappings to handle `#` aliases)
- Runs as an isolated Node project in `docs/` with its own `package.json`

**Choose this if:** You want the fastest path to a polished docs site and are OK with Node.js for the docs build. Source code embedding via `<<<` is the killer feature.

```
docs/
├── .vitepress/
│   └── config.ts          # VitePress config, sidebar, nav
├── index.md               # Landing page
├── guide/
│   ├── getting-started.md # Setup, deployment
│   ├── events.md          # Includes from src/lib/db/events.ts
│   ├── booking.md         # Includes from src/lib/booking.ts
│   ├── payments.md        # Includes from src/lib/payments.ts
│   ├── encryption.md      # Includes from src/lib/crypto.ts
│   ├── email.md           # Email configuration
│   └── api.md             # Includes from src/routes/api.ts
├── reference/
│   ├── types.md           # Includes from src/lib/types.ts
│   ├── routes.md          # Route reference
│   ├── database.md        # Schema reference
│   └── config.md          # Environment variables
└── package.json           # VitePress dependency (isolated from Deno)
```

**Example doc page:**
```markdown
## Event Types

The system supports standard (fixed date) and daily (recurring) events:

<<< @/../src/lib/types.ts#event-types {typescript}

## Encryption Model

All PII is encrypted at rest using hybrid RSA-OAEP + AES-256-GCM:

<<< @/../src/lib/crypto.ts#encrypt-pii {typescript}
```

---

### Option C: Starlight (Astro) (Best Auto-Generated API Docs)

**Why:** The `starlight-typedoc` plugin generates full API reference pages automatically. Component islands allow interactive demos. Excellent accessibility and i18n.

**Choose this if:** Auto-generated API reference is the priority and you're willing to invest in `tsconfig.json` path mappings for TypeDoc compatibility.

---

### Option D: `deno doc --html` (Simplest Starting Point)

**Why:** One command, zero dependencies, perfect Deno compatibility:
```bash
deno doc --html --name="Chobble Tickets" --output=./docs/ src/index.ts
```

**Choose this if:** You want pure API reference docs with zero setup. Can always layer a narrative docs solution on top later.

---

### Quick Decision Guide

| Priority | Best choice |
|---|---|
| Deepest source integration, Deno-native | **Lume + `deno doc`** |
| Fastest polished result, narrative docs | **VitePress** |
| Auto-generated API reference pages | **Starlight + `starlight-typedoc`** |
| Zero setup, API-only docs | **`deno doc --html`** |
| Prose-only guides, minimal tooling | **mdBook** |

---

### Suggested Phased Approach

1. **Phase 1:** Start with `deno doc --html` for instant API reference (one command, zero config)
2. **Phase 2:** Add VitePress or Lume for narrative docs (guides, tutorials, feature docs)
3. **Phase 3:** Add CI workflow to rebuild docs on push, deploy to GitHub Pages
4. **Phase 4:** Add `// #region` markers to source files for targeted code embedding in docs
