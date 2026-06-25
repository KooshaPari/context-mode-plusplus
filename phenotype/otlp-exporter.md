# otlp-exporter.md

**Adapter spec for emitting context-mode `tool_call` events via OTLP/HTTP.**

## Context

`context-mode` (MCP server) produces a stream of `tool_call` events as the
agent invokes its sandboxed tools. These are valuable for audit, debugging,
and observability — but they live in context-mode's local SQLite + console log
by default.

Substrate's `substrate-trace` crate already exposes an OTLP/HTTP exporter
(`PhenoOtelTrace`) for task lifecycle events. We can reuse it to emit
context-mode's tool_call events into the same OTLP stream.

## Architecture

```
context-mode (MCP server)
    |
    | tool_call events (JSON lines over stdout or /events endpoint)
    v
substrate-context-mode-adapter
    |
    | substrate::domain::ToolCall
    v
substrate::substrate-trace::PhenoOtelTrace
    |
    | OTLP/HTTP POST to <PHENO_OTEL_ENDPOINT>/v1/traces
    v
PhenoObservability backend (Grafana, Datadog, Honeycomb, etc.)
```

## Implementation pointer

The wiring is a thin subscriber that converts context-mode's event shape into
`substrate_core::ports::TracePort::ship(...)` calls:

```rust
// substrate-context-mode-adapter/crates/otlp-bridge/src/lib.rs

use substrate_trace::PhenoOtelTrace;
use substrate_core::ports::TracePort;

pub struct ContextModeOtlpBridge {
    inner: Arc<PhenoOtelTrace>,
    source: ContextModeEventSource, // stdout line stream or HTTP SSE
}

impl ContextModeOtlpBridge {
    pub async fn run(self) {
        let mut events = self.source.subscribe().await;
        while let Some(ev) = events.next().await {
            let trace_event = convert_tool_call_to_router_trace(&ev);
            self.inner.ship(&serde_json::to_string(&trace_event).unwrap()).await;
        }
    }
}

fn convert_tool_call_to_router_trace(ev: &ContextModeToolCallEvent) -> RouterTrace {
    RouterTrace {
        version: "0.1.0".into(),
        trace_id: ev.trace_id,
        task_id: ev.task_id,
        event_type: RouterTraceEventType::EngineResponseChunk,
        attributes: hashmap! {
            "engine".into() => "context-mode".into(),
            "tool_name".into() => ev.tool_name.clone(),
            "input_size_bytes".into() => ev.input_size.to_string(),
            "output_size_bytes".into() => ev.output_size.to_string(),
            "sandboxed".into() => ev.sandboxed.to_string(),
            "duration_ms".into() => ev.duration_ms.to_string(),
        },
        occurred_at: ev.timestamp,
        ..Default::default()
    }
}
```

## Trace attributes emitted

| Attribute | Source | Type | Example |
|---|---|---|---|
| `engine` | constant | string | `"context-mode"` |
| `tool_name` | `ctx_execute` / Read / Grep / etc. | string | `"Read"`, `"Grep"`, `"ctx_execute"` |
| `input_size_bytes` | MCP `tool_call.input` size | int | `5120` |
| `output_size_bytes` | sandboxed output size | int | `51200` (raw) or `1024` (sandboxed) |
| `sandboxed` | whether output went through sandbox | bool | `"true"` |
| `duration_ms` | wall-clock | int | `234` |

These are merged into the same trace stream as substrate task lifecycle events,
so a single Grafana dashboard can correlate `task_registered` → `engine_dispatched`
→ N× `engine_response_chunk` (with context-mode tool_calls) → `engine_response_complete`
→ `task_completed` for the entire dispatch.