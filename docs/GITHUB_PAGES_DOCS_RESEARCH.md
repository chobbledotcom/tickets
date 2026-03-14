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

## Recommendations

### Top Pick: VitePress

**Why:** Best balance of source integration, ease of setup, and maintenance for this project.

- File includes (`<<<`) are the killer feature — embed any section of `src/lib/types.ts`, `src/lib/crypto.ts`, route handlers, etc. directly in docs. When source changes, docs update on next build.
- Region markers (`// #region encryption` / `// #endregion`) let you surgically embed specific code sections.
- Minimal setup — runs in `docs/` folder, independent of the Deno project.
- Can add TypeDoc-generated API reference via `vitepress-plugin-typedoc` if desired later.
- Dark mode, search, responsive sidebar all built-in.

**Integration approach:**
```
docs/
├── .vitepress/
│   └── config.ts          # VitePress config, sidebar, nav
├── index.md               # Landing page
├── guide/
│   ├── getting-started.md # Setup, deployment
│   ├── events.md          # Event management (includes from src/lib/db/events.ts)
│   ├── booking.md         # Booking flow (includes from src/lib/booking.ts)
│   ├── payments.md        # Payment integration (includes from src/lib/payments.ts)
│   ├── encryption.md      # Security model (includes from src/lib/crypto.ts)
│   ├── email.md           # Email configuration
│   └── api.md             # Public API (includes from src/routes/api.ts)
├── reference/
│   ├── types.md           # Core types (includes from src/lib/types.ts)
│   ├── routes.md          # Route reference
│   ├── database.md        # Schema reference
│   └── config.md          # Environment variables
└── package.json           # VitePress dependency (isolated from Deno project)
```

**Example source integration in a doc page:**
```markdown
## Event Types

The system supports two event types — standard (fixed date) and daily (recurring):

<<< @/../src/lib/types.ts#event-types {typescript}

## Encryption Model

All PII is encrypted at rest using hybrid RSA-OAEP + AES-256-GCM:

<<< @/../src/lib/crypto.ts#encrypt-pii {typescript}
```

---

### Runner-up: Starlight (Astro)

Choose Starlight over VitePress if:
- You want `starlight-typedoc` for auto-generated API reference pages
- You want component islands (interactive demos in docs)
- You prefer Astro's content collections over VitePress's file-based approach

---

### Honorable Mention: Lume + TypeDoc hybrid

Choose this if Deno-native tooling is a priority:
- Lume generates the narrative docs site
- Custom Deno scripts import directly from `src/` to auto-generate reference pages
- TypeDoc (or `deno doc --json`) generates API reference data
- Maximum integration, but requires more custom work

---

### Recommended Approach: VitePress + Region Markers

1. Add `// #region` markers to key source files (`types.ts`, `crypto.ts`, `payments.ts`, etc.)
2. Set up VitePress in `docs/` with `package.json` (isolated Node project)
3. Write narrative docs in markdown that embed source via `<<<`
4. Add a GitHub Actions workflow to build and deploy to GitHub Pages
5. Optionally add `vitepress-plugin-typedoc` later for auto-generated API reference

This approach gives you docs that are **always in sync with source code** because they literally include it, while keeping the docs tooling isolated from the Deno project runtime.
