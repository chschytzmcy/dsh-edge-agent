# Configuration Reference

`dsh-edge-agent` is configured via **environment variables** and `cordis.yml`. All environment variables are prefixed with `DSH_EDGE_`.

## 🌐 General Configuration

| Variable | Default | Range | Description |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | Launcher message language (does NOT affect agent content language) |
| `DSH_EDGE_WORKSPACE` | cwd | any path | Working directory |
| `DSH_EDGE_RESUME_SESSION` | — | session id | Set via `--resume` |
| `DSH_EDGE_PERMISSION_MODE` | `ask` | `ask` / `workspace-write` / `danger-full-access` | Permission mode |

## 🔐 TEE Configuration

| Variable | Default | Range | Description |
|---|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | `simulated` / `trustzone` / `keystone` / `sgx` | TEE backend type |
| `DSH_EDGE_TEE_INFERENCE` | `false` | `true` / `false` | Run LLM inference inside TEE |
| `DSH_EDGE_SECURE_MEM` | `67108864` | bytes | Secure memory cap |

### `DSH_EDGE_TEE_TYPE`

- **`simulated`** (default): pure JS, dev/CI only
- **`trustzone`**: ARM TrustZone (recommended for production)
- **`keystone`**: RISC-V Keystone
- **`sgx`**: Intel SGX (server-side testing)

## 💾 Storage Configuration

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/` | Encrypted storage root |
| `DSH_EDGE_STORAGE_FILE` | `storage.enc.db` | SQLite filename |

## 📜 Policy Configuration

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_POLICY_PATH` | `~/.dsh-edge-agent/policy.json` | Privacy policy file path |
| `DSH_EDGE_POLICY_HOT_RELOAD` | `true` | Hot-reload policy file |
| `DSH_EDGE_POLICY_WATCH_MS` | `5000` | Policy file poll interval |

## 🚦 Routing Configuration

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_DEFAULT_DATA_LEVEL` | `sanitized` | Default data level (`public` / `sanitized` / `internal`) |
| `DSH_EDGE_ROUTER_LLM_FALLBACK` | `true` | Fall back to LLM classifier on low rule confidence |
| `DSH_EDGE_ROUTER_THRESHOLD` | `0.6` | Rule match confidence threshold |
| `DSH_EDGE_GUARD_MODEL` | `false` | Enable model-assisted prompt-guard detection |

## 🤖 Model Configuration

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_DEFAULT_MODEL` | `local-qwen3-4b` | Default model |
| `DSH_EDGE_LOCAL_MODELS` | `local-qwen3-4b,local-llama3-8b` | Local model list (comma-separated) |
| `DSH_EDGE_CLOUD_MODELS` | `cloud-deepseek-v4,cloud-deepseek-v3` | Cloud model list (comma-separated) |

### Local LLM

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_LOCAL_MODEL_PATH` | `~/.dsh-edge-agent/models/qwen3-4b.gguf` | GGUF model path |
| `DSH_EDGE_LOCAL_CTX` | `8192` | Context window size |
| `DSH_EDGE_LOCAL_THREADS` | `4` | Inference thread count |

### Cloud LLM

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_CLOUD_KEY_ENV` | `DEEPSEEK_API_KEY` | API key env var name |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |

## 🌐 Outbound Configuration

| Variable | Default | Range | Description |
|---|---|---|---|
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | `ohttp` / `tls` / `auto` | Outbound mode |
| `DSH_EDGE_BRIDGE_ALLOW` | — | domain list | Allowed domains (comma-separated) |
| `DSH_EDGE_BRIDGE_DENY` | — | domain list | Denied domains (comma-separated) |
| `DSH_EDGE_BRIDGE_TIMEOUT_MS` | `30000` | ms | Request timeout |

### OHTTP

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_OHTTP_RELAY` | — | OHTTP relay URL |
| `DSH_EDGE_OHTTP_TARGET` | — | OHTTP target URL |
| `DSH_EDGE_OHTTP_PUBKEY` | — | HPKE public key |
| `DSH_EDGE_OHTTP_KEY_ID` | — | OHTTP key id |
| `DSH_EDGE_ALLOW_FALLBACK_TLS` | `false` | Allow TLS fallback when OHTTP is unavailable |

## 🛡️ Audit & Threat Detection

### Audit Log

| Variable | Default | Range | Description |
|---|---|---|---|
| `DSH_EDGE_AUDIT_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `security` | Min log level |
| `DSH_EDGE_AUDIT_SENSITIVE_FIELDS` | — | field name list | Fields to treat as sensitive |
| `DSH_EDGE_AUDIT_ALERTS` | `true` | `true` / `false` | Enable alerts |
| `DSH_EDGE_AUDIT_CLOUD_RATE` | `20` | number | Per-minute cloud request alert threshold |
| `DSH_EDGE_AUDIT_SAN_FAIL` | `3` | number | Sanitization failure alert threshold |
| `DSH_EDGE_AUDIT_PERM_DENIED` | `5` | number | Permission-denied alert threshold |
| `DSH_EDGE_AUDIT_FLUSH_MS` | `500` | ms | Flush interval |

### Threat Detection

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_TD_WINDOW` | `60` | Time window (seconds) |
| `DSH_EDGE_TD_CLOUD_RATE` | `20` | Max cloud requests in window |
| `DSH_EDGE_TD_SAN` | `3` | Consecutive sanitization failure threshold |
| `DSH_EDGE_TD_PERM` | `5` | Consecutive permission-denied threshold |

## 🛠️ Tool Configuration

### Local Tools

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_LOCAL_TOOLS_ALLOW` | — | Allowed path prefixes (comma-separated) |
| `DSH_EDGE_LOCAL_TOOLS_WRITE` | `false` | Allow write operations |
| `DSH_EDGE_LOCAL_TOOLS_MAX` | `10485760` | Max file size |

### Web Search

| Variable | Default | Range | Description |
|---|---|---|---|
| `DSH_EDGE_WEB_BACKEND` | `duckduckgo` | `duckduckgo` / `brave` / `custom` | Backend |
| `DSH_EDGE_WEB_MAX` | `8` | number | Max results |

## 🎤 Voice Input

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_VOICE_MODEL` | `~/.dsh-edge-agent/models/whisper-tiny.bin` | Whisper model path |
| `DSH_EDGE_VOICE_VAD` | `0.6` | VAD silence threshold (seconds) |
| `DSH_EDGE_VOICE_SR` | `16000` | Sample rate |

## 🔌 Plugin Configuration

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_PLUGINS_THIRD_PARTY` | `false` | Allow third-party plugins |

## 🌐 HTTP API (optional)

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `127.0.0.1` | HTTP server bind address |
| `DSH_EDGE_HTTP_PORT` | `3080` | HTTP server port |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token (disabled if unset) |
| `DSH_EDGE_HTTP_REQUIRE_ATTEST` | `true` | Require attestation |

## 📊 Telemetry

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_TELEMETRY` | `false` | Enable DSH telemetry |

## ⚙️ Sessions

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | Session JSONL root |
| `DSH_EDGE_SESSION_TTL` | `3600` | Default TTL (seconds) |
| `DSH_EDGE_MAX_SESSIONS` | `8` | Max concurrent sessions |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | Intent-router session window size |

## ⚙️ Bash

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_BASH_TIMEOUT_MS` | `60000` | Bash command timeout (ms) |

## 🛠️ Overriding via cordis.yml

Environment variables set defaults, but you can override any config in `cordis.patch.yml`:

```yaml
- id: tcm
  config:
    teeType: trustzone
    keyStorePath: /opt/secure/keys
    teeInference: true
    secureMemoryLimit: 134217728  # 128 MiB
```

Priority: **cordis.yml > environment variables > Schema defaults**

## 🔗 Related Documentation

- [Architecture](architecture.en.md)
- [Threat Model](threat-model.en.md)
- [Plugin Development](plugin-development.en.md)