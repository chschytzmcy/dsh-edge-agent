# dsh-edge-agent Architecture

> Version: v0.1.0 · Last updated: 2026-08-18

## 🎯 Design Goals

The core goal of `dsh-edge-agent` is to run a **privacy-first** AI agent on the **user's device** while maintaining collaboration with cloud LLMs. Specifically:

1. **Data minimization**: Sensitive data never leaves the device
2. **Zero-trust communication**: The cloud cannot link requests to user identity
3. **Verifiable security**: Remote attestation via TEE
4. **Extensible architecture**: Cordis plugin mechanism for custom capabilities

## 🏛️ Overall Architecture

`dsh-edge-agent`'s architecture is divided into **four layers**:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4: User Interaction                                │
│   - CLI / HTTP API / Voice                              │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Agent Layer (DSH Agent Loop)                   │
│   - agents, llm, tools, sessions                        │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Privacy Control (dsh-edge-agent core)          │
│   - intent-router, prompt-guard, sanitizer-pipeline     │
│   - privacy-policy, audit-log, td-bus                  │
├─────────────────────────────────────────────────────────┤
│ Layer 1: Security Base                                   │
│   - tcm, local-storage, attestation                     │
│   - ohttp-gateway, secure-bridge                        │
└─────────────────────────────────────────────────────────┘
```

Each layer calls downward; reverse dependencies are forbidden.

## 🔌 Plugin Tree

`dsh-edge-agent` consists of **19 core plugins + 1 optional http-api**. All plugins follow Cordis's `name` + `inject` + `Config` + `apply` pattern.

### Dependency Graph

```
                  tcm (Trusted Computing)
                    │
        ┌───────────┼───────────┐
        │           │           │
   local-storage  attestation  audit-log
        │           │           │
        └─────┬─────┘           │
              │                 │
         sessions          privacy-policy
              │                 │
              └────────┬────────┘
                       │
                  tools (Realm-aware)
                       │
        ┌──────────────┼──────────────┐
        │              │              │
  local-tools    web-search     voice-input
        │              │              │
        └──────────────┘              │
                                      │
   prompt-guard ◄─── intent-router ◄─┘
        │              │
        │              ├──── model-router
        │              │
        │       sanitizer-pipeline
        │
   td-bus ◄─── secure-bridge ◄── ohttp-gateway
                                     │
                              cloud-llm-adapter

   plugin-host (interop anchor, third-party plugin mount point)

   http-api (optional, external consumer interface)
```

### Plugin Roster

| Plugin | Responsibility | Realm |
|---|---|---|
| `tcm` | Trusted Computing Module (TEE key management) | — |
| `local-storage` | AES-256-GCM encrypted SQLite | LOCAL |
| `sessions` | Encrypted session lifecycle | LOCAL |
| `audit-log` | Tamper-evident audit log | LOCAL |
| `privacy-policy` | Hot-reloadable policy engine | — |
| `tools` | Realm-aware tool registry | — |
| `prompt-guard` | Input/output safety scanner | — |
| `intent-router` | Intent classification & routing | — |
| `model-router` | LLM router (local / cloud) | — |
| `local-llm-adapter` | Local LLM adapter | LOCAL |
| `cloud-llm-adapter` | Cloud LLM adapter | CLOUD |
| `sanitizer-pipeline` | PII sanitization pipeline | SANITIZED |
| `ohttp-gateway` | OHTTP (RFC 9458) gateway | — |
| `secure-bridge` | Edge-cloud secure bridge | — |
| `attestation` | TEE remote attestation | — |
| `td-bus` | Threat detection bus | — |
| `local-tools` | Local tool bundle | LOCAL |
| `web-search` | Public web search | CLOUD |
| `voice-input` | Voice input | LOCAL |
| `plugin-host` | Third-party plugin interop anchor | — |
| `http-api` | HTTP API (optional) | — |

## 🌍 Realm Model

`dsh-edge-agent` introduces a **Realm model** that divides all data processing into three domains:

| Realm | Data flow | Typical use case | Security level |
|---|---|---|---|
| **LOCAL** | Fully processed on-device | File reads, math, local LLM inference | Highest |
| **SANITIZED** | Sanitized data sent to cloud | General Q&A (PII auto-replaced) | Medium |
| **CLOUD** | Raw data sent to cloud | User-authorized cloud tasks | Lowest (requires user grant) |

Every tool must declare its realm on registration; intent-router selects the realm based on user input and data sensitivity.

## 🔐 Security Control Flow

A typical user request flows through the following security checkpoints:

```
User Input
  ↓
[1] prompt-guard.checkInput()    # Detect prompt injection
  ↓
[2] intent-router.classify()     # Classify intent + realm
  ↓
[3] privacy-policy.check()       # Verify against policy
  ↓
[4] sanitizer-pipeline.sanitize() # Sanitize (if needed)
  ↓
[5] tools.invoke() OR llm.invoke() # Execute
  ↓
[6] audit-log.log()              # Record audit
  ↓
[7] td-bus.analyze()             # Threat detection
  ↓
Return result
```

Each step may **reject the request** or **escalate to a higher security level**.

## 📦 Adapter Boundary

`dsh-edge-agent` strictly isolates upstream DSH APIs:

```
src/
  dsh-adapter/    ← The only directory allowed to import @deepseek-ai/*
  *.ts            ← Only via dsh-adapter/types.ts for types
```

Enforced by `verify-adapter-boundary.ts` in CI.

## 🚀 Boot Sequence

1. **CLI launcher** (`bin/dsh-edge-agent.js`):
   - Probe `dsh` CLI
   - Bootstrap `$DSH_HOME/profiles/dsh-edge-agent/` profile
   - Intercept `--resume` argument
   - Pass through to `dsh --profile dsh-edge-agent`

2. **DSH profile boot**:
   - Load `cordis.yml` + `cordis.patch.yml`
   - Instantiate plugins in dependency order
   - Start agent loop

3. **dsh-edge-agent main plugin** (`src/dsh-adapter/index.ts`):
   - Check TEE availability
   - Load privacy policy
   - Register LLM adapters
   - Start audit log

## 📐 Roadmap

| Version | Status | Scope |
|---|---|---|
| **v0.1.0** | ✅ Current | Scaffold: all plugin structure + stub impls |
| v0.2.0 | Planned | S1-S5: Full LOCAL realm + local LLM |
| v0.3.0 | Planned | S6-S9: Full SANITIZED realm + sanitization |
| v0.4.0 | Planned | S10-S11: TEE integration + remote attestation |
| v0.5.0 | Planned | S12: E2E tests + perf benchmarks |
| v0.6.0 | Planned | S13: http-api + third-party plugin marketplace |
| v1.0.0 | Planned | Production-ready + real TEE deployment |

## 🔗 Related Documentation

- [Installation Guide](installation.en.md)
- [Configuration Reference](configuration.en.md)
- [Threat Model](threat-model.en.md)
- [Plugin Development](plugin-development.en.md)