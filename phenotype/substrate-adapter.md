# substrate-adapter.md

**Adapter spec for bridging mksglu/context-mode into KooshaPari/substrate.**

## Context

`context-mode` reduces tool output via sandboxing (98% reduction). It runs as an
MCP server consumed by 17+ AI coding clients.

`substrate::context-budget` is an `EnginePort` middleware that enforces per-conv
token-budget limits using a `chars/4` heuristic. It runs as part of the
substrate dispatch layer, between the substrate driver and the underlying agent
engine (engine-agentapi, engine-claude, engine-codex, engine-forge,
cliproxy-adapter, omniroute-adapter).

These two systems are complementary: context-mode's output sandboxing reduces
prompt size *before* substrate sees the message, while context-budget's
middleware enforces a hard upper limit *inside* substrate. Chaining them
provides defense in depth.

## Architecture

```
+-------------+       +---------------+       +-----------------+
|  MCP client |       | substrate     |       | context-mode    |
| (claude/    |       | dispatcher    |       | (MCP server)    |
|  codex/...) |       |               |       |                 |
+------+------+       +-------+-------+       +--------+--------+
       |                      |                        |
       |  ctx_execute(LLM)    |  task.prompt           |  tool_call
       |  (LLM-as-code)       |  (post-sandbox)        |  (sandboxed)
       |                      |                        |
       v                      v                        v
       |              +---------------+                |
       |              | context-budget|                |
       |              | (EnginePort   |                |
       |              |  middleware)  |                |
       |              +-------+-------+                |
       |                      |                        |
       |                      v                        |
       |              +---------------+                |
       +------------->+ EnginePort    |<---------------+
                      | (claude/      |
                      |  codex/etc.)  |
                      +---------------+
```

The `substrate-adapter` exposes context-mode's MCP server as a `ToolPort`
(defined in `substrate_core::ports::ToolPort`). Substrate drivers
(`driver-http`, `driver-mcp`, `driver-cli`) consume the adapter.

## Type surface (Rust)

```rust
// substrate-context-mode-adapter/crates/context-mode-adapter/src/lib.rs

use substrate_core::ports::ToolPort;
use substrate_core::domain::{ToolCall, ToolResult};

pub struct ContextModeAdapter {
    endpoint: String,            // e.g. http://127.0.0.1:3285/v1
    budget: Option<BudgetConfig>, // delegated to substrate::context-budget
}

impl ContextModeAdapter {
    pub fn new(endpoint: impl Into<String>) -> Self;
    pub fn with_budget(endpoint: impl Into<String>, budget: BudgetConfig) -> Self;
}

#[async_trait]
impl ToolPort for ContextModeAdapter {
    async fn invoke(&self, call: ToolCall) -> Result<ToolResult>;
    async fn list_tools(&self) -> Result<Vec<ToolDescriptor>>;
    async fn health(&self) -> Result<HealthStatus>;
}
```

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `CONTEXT_MODE_ENDPOINT` | `http://127.0.0.1:3285/v1` | context-mode MCP HTTP endpoint |
| `CONTEXT_MODE_BUDGET` | unlimited | if set, propagates `BudgetConfig` to `substrate::context-budget` |
| `CONTEXT_MODE_OTLP_ENDPOINT` | (none) | if set, context-mode tool_call events emit OTLP/HTTP via `substrate-trace::PhenoOtelTrace` |

## Migration guide (substrate consumer)

If you have an existing substrate consumer that wants to integrate context-mode:

1. Add `context-mode-adapter` to your `Cargo.toml`
2. Construct `ContextModeAdapter::new(env::var("CONTEXT_MODE_ENDPOINT")?)`
3. Wire it into your driver as a `ToolPort` impl
4. (Optional) Compose with `context-budget` via the `.with_budget()` builder
5. (Optional) Compose with `substrate-trace::PhenoOtelTrace` for OTLP/HTTP export

## Versioning

This adapter spec follows substrate's port-trait version cadence:

| substrate-core | adapter spec | breaking changes |
|---|---|---|
| 0.4.x | 0.1.x | none yet |
| 0.5.x | 0.2.x | adds `ToolDescriptor.metadata: Option<...>` |