## General Coding Rules

NEVER stage or unstage changes, just leave them in the working directory. The index is user-owned.

## Dev Server

- `yarn dev` serves the app at http://localhost:3000. Start it when you need to verify a change in the real
  app, and stop it when you are done.

## Repository Structure

Single Next.js app, no monorepo.

- `app/` - App Router pages and route handlers. Route handlers exist only for calls the browser cannot make itself (HMAC/JWT-signed exchange requests, CORS-blocked APIs, the native HyperSync client).
- `components/` - React components, one component per file.
- `lib/chains/` - Chain metadata and per-chain data-source selection. Ported and trimmed from `@revoke.cash/core`.
- `lib/events/` - Transfer-event log retrieval. Ported and trimmed from `@revoke.cash/core`.
- `lib/db/` - Dexie (IndexedDB) schema and repositories. This is the only persistence layer.
- `lib/sync/` - The sync engine that turns logs into balances.
- `lib/prices/`, `lib/nfts/`, `lib/exchanges/`, `lib/portfolio/` - Feature modules.

### Quick Facts

- App type: self-hosted, single-user crypto portfolio tracker. All user data lives in the browser's IndexedDB; there is no server-side database.
- Stack: Next.js 16 App Router, React 19, TypeScript (strict), Tailwind v4, TanStack Query, Zustand, Dexie, viem.
- API keys are entered in the app's settings UI and stored in IndexedDB. They are forwarded per-request to our own route handlers where server-side signing is required. Never read keys from `process.env` for user-facing features.
- Package manager: Yarn 4 via corepack.

### Conventions and Gotchas

- Prefer writing code in a way that reads top-down, from the main entry point to the leaves.
- Always use descriptive variable names without abbreviations.
- Prefer readable, maintainable code over micro-optimizations.
- Reuse existing utilities before adding new helpers.
- Keep checksummed addresses (`getAddress`) in memory, but store lowercase addresses in IndexedDB so that keys and indexes match regardless of input casing.
- Store `bigint` values as strings in IndexedDB. IndexedDB's structured clone cannot index bigints.
- Do not remove existing comments unless they are clearly outdated.
- Prefer one component per file unless multiple components are strongly justified.
- Prefer `const` assignment and not reassigning variables.
- Use descriptive variable names, no single letter variables unless they are very common and well-known (e.g. `i`, `j`, `k`).
- Prefer array methods over manual loops and avoid nested loops if possible.
- Don't use em-dashes in content.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
