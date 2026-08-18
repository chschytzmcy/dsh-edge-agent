# dsh-edge-agent

> Edge-side Private Agent · Built on DSH (DeepSeek Harness) Cordis Plugin Mechanism

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` is a user-facing edge-side private agent focused on privacy protection and secure, controllable AI interactions. Built on the [DeepSeek Harness](https://github.com/deepseek-harness) Cordis plugin mechanism, it keeps sensitive data on-device and only communicates with the cloud through zero-trust channels when necessary.

## ✨ Core Features

- **🔒 Local-first**: All data is processed by the on-device LLM by default; the cloud LLM is only invoked when the user explicitly needs it
- **🛡️ Privacy protection**: AES-256-GCM encrypted storage, TEE-managed keys, automatic PII sanitization
- **🌐 Zero-trust communication**: RFC 9458 OHTTP prevents the cloud from linking requests to user identity
- **🚨 Threat detection**: Real-time monitoring with automatic quarantine for anomalous traffic
- **🔌 Pluggable**: 19 core plugins + 1 optional http-api, all exported as subpaths

## 📦 Installation

```sh
# Prereqs: official dsh CLI and pnpm
npm install -g @deepseek-ai/dsh pnpm

# Clone and install
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent
pnpm install
./install.sh

# Launch
dsh-edge-agent
```

See [docs/installation.en.md](docs/installation.en.md) for details.

## 🏗️ Architecture

`dsh-edge-agent` uses a **single-package multi-subpath** architecture. Every plugin is exported from `@deepseek-harness-edge-agent/dsh-edge-agent`:

```
@deepseek-harness-edge-agent/dsh-edge-agent          # Main plugin (aggregator)
@deepseek-harness-edge-agent/dsh-edge-agent/tcm       # Trusted Computing Module
@deepseek-harness-edge-agent/dsh-edge-agent/privacy-policy  # Privacy policy
@deepseek-harness-edge-agent/dsh-edge-agent/ohttp-gateway   # OHTTP gateway
... 23 subpaths in total
```

Each plugin follows Cordis's `name` + `inject` + `Config` + `apply` pattern. See [docs/architecture.en.md](docs/architecture.en.md).

## ⚙️ Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | TEE backend: `simulated` / `trustzone` / `keystone` / `sgx` |
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent` | Encrypted storage root |
| `DSH_EDGE_POLICY_PATH` | `~/.dsh-edge-agent/policy.json` | Privacy policy file path |
| `DSH_EDGE_DEFAULT_DATA_LEVEL` | `sanitized` | Default data level |
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | Outbound mode: `ohttp` / `tls` / `auto` |
| `DSH_EDGE_PERMISSION_MODE` | `ask` | Permission mode: `ask` / `workspace-write` / `danger-full-access` |

See [docs/configuration.en.md](docs/configuration.en.md).

## 🔐 Security Model

`dsh-edge-agent` uses **defense in depth**:

1. **Local encryption**: All data is encrypted with AES-256-GCM; keys are protected by the TEE
2. **Intent routing**: Automatically identifies data sensitivity and routes to LOCAL / CLOUD / SANITIZED realms
3. **Sanitization pipeline**: PII (names, emails, phones, etc.) is replaced before cloud transmission
4. **OHTTP channel**: The cloud sees only sanitized data and cannot link it back to the user
5. **Threat detection**: Anomalous behavior triggers automatic quarantine (`block-cloud` / `kill-session` / `lockdown`)

See [docs/threat-model.en.md](docs/threat-model.en.md) for the complete threat model.

## 🧪 Development

```sh
# Compile
pnpm run compile

# Verify (boundary / contract / patch-surface / plugin-spec / package)
pnpm run verify:build

# Run unit tests
pnpm test

# Smoke test
pnpm run smoke
```

See [docs/plugin-development.en.md](docs/plugin-development.en.md).

## 📜 License

MIT License. See [LICENSE](LICENSE).

## 🙏 Acknowledgements

Built on [DeepSeek Harness](https://github.com/deepseek-harness) and [Cordis](https://github.com/deepseek-ai/cordis). Thanks to the DeepSeek team for their open-source contributions.

---

**⚠️ Current status**: This is the v0.1.0 scaffold. All plugin `apply` methods are placeholders; real implementations will be filled in during the S1-S13 stages. See the [design doc](docs/architecture.en.md#roadmap) for the roadmap.