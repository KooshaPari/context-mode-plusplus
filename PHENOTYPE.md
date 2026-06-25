# Phenotype+ extensions for context-mode

This fork adds substrate-ecosystem wiring on top of upstream
[mksglu/context-mode](https://github.com/mksglu/context-mode) (18.1k stars, ELv2 license).

The upstream provides:

- MCP server for sandboxing tool output (98% context reduction)
- SQLite-backed session continuity (FTS5 + BM25 retrieval)
- 17 supported MCP clients + OpenClaw gateway integration
- `ctx_execute()` script runner (think-in-code paradigm)

The **Plus** layer adds the substrate integration surface:

| Extension | What | Why |
|---|---|---|
| `phenotype/substrate-adapter.md` | Spec for bridging context-mode into `substrate::context-budget` (EnginePort middleware) | substrate's per-conv token budget can be enforced *before* context-mode receives the prompt, complementing its 98% reduction with hard caps |
| `phenotype/otlp-exporter.md` | Spec for OTLP/HTTP export of context-mode `tool_call` events via `substrate::substrate-trace::PhenoOtelTrace` | brings context-mode's tool-call audit trail into the same trace stream as the rest of substrate |
| `phenotype/cliproxy-bridge.md` | Spec for routing `ctx_execute()` LLM queries through `substrate::cliproxy-adapter` (CLIProxyAPI OpenAI-compat HTTP) | unified provider layer across the substrate stack |
| `phenotype/Cargo.lock.example` | Reference workspace `Cargo.lock` showing how a substrate consumer should pin both repos | reproducibility for downstream users |

## Why this fork exists (not a PR upstream)

Upstream's MCP-server model is intentionally client-agnostic. The substrate
extensions add substrate-specific seams (per-conv budget middleware, OTLP/HTTP
trace export, CLIProxy routing) that would couple context-mode to the substrate
ecosystem — inappropriate for the upstream's general audience.

The substrate extensions are documented here as adapter specs rather than
in-tree code so upstream consumers don't see them as feature creep. Substrate
consumers should depend on `KooshaPari/context-mode-plusplus` and follow the
adapter specs in `phenotype/` to wire their integration.

## Sync policy

We rebase onto upstream `main` weekly. Phenotype adapter specs are kept in
the `phenotype/` directory so conflict-free merging is trivial (they're additive).

## License

ELv2 (inherited from upstream via `LICENSE`). See LICENSE for full terms.