# Agent rules for probe-mode

- Spec (binding): docs/superpowers/specs/2026-10-27-dev-feedback-loop-design.md
- Run `npm test` after every code change.
- A bug fix starts with a failing test that reproduces the bug.
- `hooks/probe-guard.mjs` must not import from `shared/` or `hooks/probe-lib.mjs`. It is fail-closed by design; keep its logging inlined.
- Logging never throws, never changes a decision, and is off unless `PROBE_RECORD` is set.
- Tests must not touch the real `~/.claude` or `~/.probe-mode`. Point `CLAUDE_CONFIG_DIR` and `PROBE_STATE_DIR` at temp dirs.
- Pure ESM `.mjs`, no build step, no runtime dependencies, `node --test` only.
- Commits: Conventional Commits, no Co-Authored-By or "Generated with" trailers.

## Smoke checklist

_Filled in a later step._
