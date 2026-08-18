# Installation Guide

## 📋 System Requirements

| Component | Minimum | Recommended |
|---|---|---|
| Node.js | ^22.19 or >=24 | >=22.20 |
| pnpm | ^10 or ^11 | ^11.7.0 |
| OS | Linux / macOS / Windows | Linux |
| Arch | x64 / arm64 | arm64 (for TEE) |

## 🔧 Prerequisites

### 1. Install the official DSH CLI

```sh
npm install -g @deepseek-ai/dsh
```

Verify:

```sh
dsh --version
```

### 2. Install pnpm

```sh
npm install -g pnpm
# or
corepack enable pnpm
```

Verify:

```sh
pnpm --version
```

### 3. (Optional) Install a TEE development environment

If you need to run on a real TEE (recommended for production):

- **ARM TrustZone**: requires building OP-TEE on a TrustZone-capable device
- **RISC-V Keystone**: requires the RISC-V toolchain
- **Intel SGX**: requires the Intel SGX SDK

For the scaffold stage, the `simulated` backend requires no real TEE.

## 📦 Installing dsh-edge-agent

### Option 1: From npm (recommended for users)

```sh
npm install -g @deepseek-harness-edge-agent/dsh-edge-agent
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent
dsh-edge-agent
```

### Option 2: From source (recommended for developers)

```sh
# Clone the repository
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

# Install dependencies
pnpm install

# Compile
pnpm run compile

# Bootstrap the profile (first run)
./install.sh

# Launch
dsh-edge-agent
```

### Option 3: Windows

```cmd
:: In PowerShell or cmd
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent

:: Launch (the repo-root .cmd shim handles --resume compatibility)
dsh-edge-agent.cmd
```

## 🚀 First Run

The first run performs the following steps:

1. **Probe the dsh CLI**: confirms `@deepseek-ai/dsh` is installed
2. **Create the profile**: creates an isolated profile at `$DSH_HOME/profiles/dsh-edge-agent/`
3. **Install dependencies**: uses pnpm to install all DSH deps
4. **Apply the patch**: mounts dsh-edge-agent plugins via `cordis.patch.yml`
5. **Create the storage directory**: defaults to `~/.dsh-edge-agent/`
6. **Load the default policy**: `~/.dsh-edge-agent/policy.json`

After these steps, the agent loop starts and waits for user input.

## 🔍 Verifying the Installation

```sh
# Check the profile is ready
ls $DSH_HOME/profiles/dsh-edge-agent/

# Check plugins are mounted
dsh --profile dsh-edge-agent --dump-config | grep -E "dsh-edge-agent|tcm|ohttp"

# Run the smoke test
cd dsh-edge-agent
pnpm run smoke
```

## 🐛 Troubleshooting

### "dsh CLI not found"

```sh
npm install -g @deepseek-ai/dsh
hash -r   # refresh shell cache
```

### "pnpm not found"

```sh
npm install -g pnpm
# or
corepack enable pnpm
```

### "profile runs v0.0.X but launcher is v0.1.0"

The profile is older than the launcher and may crash at boot. Align:

```sh
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent@latest
```

### "adapter boundary violated"

`@deepseek-ai/*` imports exist outside `src/dsh-adapter/`. Fix:

1. Move the import inside `src/dsh-adapter/`, or
2. Re-export through `src/dsh-adapter/types.ts`

### "upstream contract violated"

DSH dependency versions do not match `UPSTREAM_VALIDATED_VERSION` (`0.1.0-rc.6`). Fix:

```sh
pnpm install
# or
pnpm update @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm ...
```

## 🗑️ Uninstalling

```sh
# Remove the profile
dsh plugin --profile dsh-edge-agent remove @deepseek-harness-edge-agent/dsh-edge-agent

# Remove storage (WARNING: deletes all sessions and encrypted data!)
rm -rf ~/.dsh-edge-agent/

# Remove the global package (if installed)
npm uninstall -g @deepseek-harness-edge-agent/dsh-edge-agent
```

## 🔗 Next Steps

- [Configuration Reference](configuration.en.md)
- [Architecture](architecture.en.md)
- [Plugin Development](plugin-development.en.md)