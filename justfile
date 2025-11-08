# Typed/strict TypeScript project helpers via `just`.
# Wraps npm scripts to keep the codebase tidy and reproducible.

set dotenv-load := true

# Default: show available recipes
default:
    @just --list

# Install dependencies for local dev
install:
    npm install

# Clean, reproducible CI install (uses lockfile)
ci-install:
    npm ci

# Clean build artifacts and caches
clean:
    npm run clean

# Build TypeScript (no emit errors allowed)
build:
    npm run build

# Start dev mode (hot reload)
dev:
    npm run dev

# Start compiled app (after `build`)
start: build
    npm start

# Formatting
# `fmt` writes changes (like `cargo fmt`)
fmt:
    npm run format-fix

# Non-writing format verification
fmt-check:
    npm run format

# Linting (check / fix)
lint:
    npm run lint

lint-fix:
    npm run lint-fix

# Type-check only (no emit)
typecheck:
    npm run typecheck

# Unit tests
test:
    npm test

# Firecrawl pipeline test
test-firecrawl:
    npm run test:firecrawl

# Aggregate “verify everything” without writing changes
check: fmt-check lint typecheck test
    @echo "✓ All checks passed"

# Apply automatic fixes (format + lint)
fix: fmt lint-fix
    @echo "✓ Applied formatting and lint fixes"

# CI-friendly pipeline: clean install, verify, then build
ci: ci-install check build
    @echo "✓ CI pipeline completed"
