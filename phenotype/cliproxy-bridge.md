# cliproxy-bridge.md

**Adapter spec for routing context-mode `ctx_execute()` LLM queries through substrate's cliproxy-adapter.**

## Context

`context-mode`'s `ctx_execute()` runs code in a sandboxed JavaScript runtime
that may itself invoke an LLM (e.g., to summarize a 50-file output). Today
this LLM call goes directly to whatever provider is configured in
context-mode's local settings.

Substrate's `cliproxy-adapter` is an `EnginePort` adapter for the
OpenAI-compat HTTP gateway exposed by `KooshaPari/cliproxyapi-plusplus`
(32 stars, MIT, fork of `router-for-me/CLIProxyAPI` at 38k stars). It supports
50+ providers (Claude, Codex, Gemini, Copilot, etc.) via a single endpoint.

Routing context-mode's internal LLM calls through cliproxy-adapter unifies
provider selection with the rest of the substrate stack.

## Architecture

```
context-mode (MCP server)
    |
    | ctx_execute("summarize this 50-file output", { llm: true })
    v
context-mode-llm-adapter
    |
    | substrate::domain::ChatRequest
    v
substrate::cliproxy-adapter
    |
    | OpenAI-compat POST to http://127.0.0.1:8317/v1/chat/completions
    v
CLIProxyAPI binary (forked, served by cliproxyapi-plusplus)
    |
    | /v1/chat/completions (provider-agnostic)
    v
50+ upstream providers (claude, codex, gemini, copilot, ...)
```

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CLIPROXY_BASE_URL` | `http://127.0.0.1:8317/v1` | cliproxy OpenAI-compat endpoint |
| `CLIPROXY_API_KEY` | (none) | bearer token if cliproxy requires auth |
| `CLIPROXY_DEFAULT_MODEL` | `claude-opus-4-7` | model used for context-mode internal LLM calls |
| `CONTEXT_MODE_LLM_PROVIDER` | `cliproxy` | set to `cliproxy` to route through substrate's cliproxy-adapter instead of context-mode's native provider |

## Routing decision

By default, substrate's `RoutingPort` (typically `routing-phenotype-router`)
selects the model. context-mode internal LLM calls are tagged with
`attributes.caller = "context-mode"` so the router can apply a different
routing policy (e.g., prefer cheap models for summarization tasks).

## Example routing policy

```yaml
# routing-policy.yaml (consumed by substrate::routing-phenotype-router)
defaults:
  caller: "substrate"

policies:
  - match:
      caller: "context-mode"
    decision:
      engine: "engine-agentapi-claude"
      model: "claude-sonnet-4-7"  # cheaper for context-mode internal calls
      reason: "context-mode internal summarization"
```

## Implementation pointer

The adapter is a thin wrapper that converts context-mode's internal LLM call
to a `ChatRequest` and delegates to `CliproxyEngine`:

```rust
// substrate-context-mode-adapter/crates/llm-bridge/src/lib.rs

use substrate_clipoxy_adapter::CliproxyEngine;
use substrate_core::domain::{ChatRequest, ChatMessage};

pub struct ContextModeLlmBridge {
    inner: Arc<CliproxyEngine>,
    default_model: String,
}

impl ContextModeLlmBridge {
    pub async fn complete(&self, prompt: &str, system: Option<&str>) -> Result<String> {
        let mut messages = vec![];
        if let Some(sys) = system {
            messages.push(ChatMessage::System { content: sys.into() });
        }
        messages.push(ChatMessage::User { content: prompt.into() });

        let req = ChatRequest {
            model: self.default_model.clone(),
            messages,
            ..Default::default()
        };
        let resp = self.inner.chat_completion(req).await?;
        Ok(resp.choices[0].message.content.clone())
    }
}
```

## Why this matters

- **Single provider surface** — substrate consumers get one config to rule all LLM calls (dispatch + context-mode internal)
- **Provider failover** — cliproxy-adapter's provider pool lets context-mode LLM calls fail over across 50+ providers
- **Cost controls** — substrate's `context-budget` middleware can cap context-mode's internal LLM spend separately from dispatch LLM spend
- **Audit trail** — every context-mode internal LLM call is a substrate `task_completed` event in the OTLP/HTTP trace stream