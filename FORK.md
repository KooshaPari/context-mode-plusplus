# FORK.md — context-mode-plusplus

## Upstream

**Upstream repo:** [mksglu/context-mode](https://github.com/mksglu/context-mode)
**Upstream license:** Elastic-2.0 (ELv2) — inherited by this fork; see `LICENSE`.
**Fork owner:** [KooshaPari](https://github.com/KooshaPari)

## What this fork adds (the ++ delta)

This fork is a Phenotype-ecosystem integration layer on top of upstream context-mode.
All upstream functionality is preserved unchanged; the fork adds substrate-specific
adapter specs and wiring that would couple upstream to the Phenotype stack.

| Extension | Location | Purpose |
|---|---|---|
| Substrate adapter spec | `phenotype/substrate-adapter.md` | Bridges `ctx_execute` into `substrate::context-budget` (EnginePort middleware) — enforces per-conversation token budgets *before* context-mode receives the prompt |
| OTLP exporter spec | `phenotype/otlp-exporter.md` | Exports `tool_call` audit events via `substrate::substrate-trace::PhenoOtelTrace` into the substrate OTLP/HTTP stream |
| CLIProxy bridge spec | `phenotype/cliproxy-bridge.md` | Routes `ctx_execute()` LLM queries through `substrate::cliproxy-adapter` (OpenAI-compat HTTP) for unified provider management |
| Cargo.lock example | `phenotype/Cargo.lock.example` | Reference workspace `Cargo.lock` for downstream Rust consumers pinning both repos |
| Phenotype overview | `PHENOTYPE.md` | Prose overview of the substrate integration rationale |

## Why not upstream

Upstream's MCP-server model is intentionally client-agnostic. These extensions add
substrate-specific seams (per-conv budget middleware, OTLP/HTTP trace export, CLIProxy
routing) that would couple context-mode to the Phenotype ecosystem — inappropriate for
the upstream's general audience. They live here as adapter specs, not in-tree code, so
upstream consumers see no feature creep.

## Sync cadence

We rebase onto upstream `main` at least weekly. All Phenotype additions live in:
- `phenotype/` — adapter specs (additive, zero upstream file conflicts)
- `FORK.md` / `PHENOTYPE.md` — fork documentation (additive)

Rebasing is mechanical: `git fetch upstream && git rebase upstream/main`.

## Upstream divergence tracker

| Date | Upstream commit | Fork action | Notes |
|---|---|---|---|
| 2026-06-30 | `8d490b9` (ci: update install stats) | Cloned as fork base | Initial fork base, all upstream commits included |

**To update this table:** after each `git rebase upstream/main`, append a row with today's
date, the new upstream HEAD SHA, the rebase action taken, and any conflict notes.

## Attribution

Original work by [Mert Koseoğlu](https://github.com/mksglu) and contributors — see
upstream [CONTRIBUTORS](https://github.com/mksglu/context-mode/graphs/contributors) and
upstream [CHANGELOG](https://github.com/mksglu/context-mode/blob/main/CHANGELOG.md).

This fork does not modify upstream source files; all changes are additive (new files only)
except where the upstream tracker table above notes otherwise.
