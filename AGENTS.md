# Agent Guide (TypeScript, Concise)

Typed, functional-first TypeScript/Node utilities and agent components for the Validator. Follow these rules exactly.

## Core Non‑Negotiables

- No Gambiarra: no hacks, no duct tape. If a change is ambiguous or risky, stop and ask for feedback. Do not ship half-baked work.
- LLM‑friendly structure: keep files and functions small. Split aggressively. Use precise names following TS conventions.
- Functional + strict typing: prefer pure functions and composition; absolutely no side effects at import time. Zero implicit `any` and zero type errors.
- Validate LLM output with Zod: keep schemas minimal and typed.
- Side‑effect boundaries: keep I/O, network, and database in thin adapters; keep domain logic pure and testable.
- Explicit errors only: throw specific error types; avoid broad catch‑alls that swallow context.

## Author Preferences (Concise & On‑Point)

- Concise, scope‑true solutions: stick strictly to the prompt’s scope; no scope creep.
- On‑point outputs: deliver precise, directly useful results; skip filler.
- No redundant code: avoid duplication or unnecessary rewrites of existing functions.
- Reuse first: compose with existing utilities; extend only when needed.
- Idiomatic + production‑ready: favor clear, minimal TypeScript that ships correctly.
- First‑principles + generalization: reason from fundamentals; prefer minimal, general designs.
- Preserve the spirit of the divine abstract‑thinking, idiomatic programmer.

## NO GAMBIARRA POLICY - ASK FOR FEEDBACK INSTEAD

Due to the difficulty of implementing this codebase, we must strive to keep the
code high quality, clean, modular, simple and functional - more like an Agda
codebase, less like a C codebase. Gambiarras, hacks and duct taping must be
COMPLETELY AVOIDED, in favor of robust, simple and general solutions.

In some cases, you will be asked to perform a seemingly impossible task, either
because it is (and the user is unaware), or because you don’t grasp how to do it
properly. In these cases, DO NOT ATTEMPT TO IMPLEMENT A HALF-BAKED SOLUTION JUST
TO SATISFY THE USER’S REQUEST. If the task seems too hard, be honest that you
couldn’t solve it in the proper way, leave the code unchanged, explain the
situation to the user and ask for further feedback and clarifications.

The user is a domain expert that will be able to assist you in these cases.

## Tooling & Environment

- Node.js + TypeScript (ESM). Compile with `tsc`; run local with `tsx`.
- Lint/format with ESLint + Prettier. Type‑check with `tsc --noEmit`. CI must block on format, lint, type, and tests.
- Single source of config: `tsconfig.json`, `eslint.config.js`, Prettier defaults.
- Environment via `.env` (see `.env.example`); validate with `src/env.ts` (Zod).
- Do not assume global tools; rely on `npm` scripts for reproducible tooling.

## Layout & Conventions

- Source root: `src/`.
- Example structure: `src/db/`, `src/search/`, `src/env.ts`, `src/validator.ts`, `src/utils.ts`, `src/index.ts`.
- Standard library first and idiomatic:
  - FS via `node:fs/promises`; URL via `URL`; HTTP via `fetch` with `AbortSignal`.
  - Concurrency: prefer `async/await` and `Promise.all`; avoid worker threads/processes unless necessary.
- Typing patterns: prefer `unknown` over `any`; use discriminated unions, `readonly`, `as const`, `Record`, utility types. Narrow early; eliminate non‑null assertions.
- Naming: `camelCase` for values/functions, `PascalCase` for types/classes, uppercase `SCREAMING_SNAKE_CASE` for constants. Filenames lowercase/kebab where sensible.
- Split aggressively into small modules; navigation should be intuitive. Keep files slim to aid LLM context.

## Workflow

- Use `apply_patch` for changes; keep diffs minimal and focused.
- Do not edit this guide (`AGENTS.md`) without explicit user approval; always ask first.
- After edits: `npm run lint`, `npm run format`, `npm run typecheck`, `npm test`, optional `npm run build`.
- When integrating model outputs, validate with Zod schemas.
- If requirements are unclear or conflict with these rules, stop and ask. No gambiarra.
- Commit messages: use Conventional Commits (e.g., `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, `ci:`, `perf:`, `style:`); add optional scope, `!` for breaking changes; keep summary ≤72 chars.

## Local Commands

- Install deps: `npm install`.
- Dev (hot reload): `npm run dev`.
- Build: `npm run build` and run with `npm start`.
- Lint: `npm run lint`; Format: `npm run format` (use `format-fix` to write).
- Type‑check: `npm run typecheck`; Tests: `npm test` (Vitest).

## Dependencies

- Prefer Node/TS stdlib. If adding a third‑party lib, justify it, keep surface minimal, and pin via `package.json` (lockfile tracked). Prefer ESM‑ready packages.
- Keep optional imports local with clear error messages.

## Testing & Docs

- Tests: Vitest with small, focused cases. Type‑check tests. Aim for high coverage of public APIs.
- Docs: concise TSDoc/JSDoc comments; runnable examples when useful.
