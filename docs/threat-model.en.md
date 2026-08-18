# Threat Model

> This document uses [STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) methodology to describe dsh-edge-agent's threat model.

## 🎯 Trust Boundary

`dsh-edge-agent`'s trust boundary is as follows:

```
┌─────────────────────────────────────────┐
│          Trust Boundary (Device)         │
│                                         │
│   ┌──────────────────────────────┐     │
│   │  dsh-edge-agent process       │     │
│   │   - LOCAL realm               │     │
│   │   - SANITIZED realm           │     │
│   └──────────────────────────────┘     │
│                                         │
│   ┌──────────────────────────────┐     │
│   │  TEE (Trusted Execution Env)  │     │
│   │   - Keys                       │     │
│   │   - Crypto primitives          │     │
│   └──────────────────────────────┘     │
│                                         │
└─────────────────┬───────────────────────┘
                  │
                  │  OHTTP (encrypted + anonymized)
                  │
┌─────────────────┴───────────────────────┐
│           Untrusted (Cloud)              │
│   ┌──────────────────────────────┐     │
│   │  Cloud LLM                    │     │
│   │   - Sees sanitized data       │     │
│   │   - No user identity          │     │
│   └──────────────────────────────┘     │
└─────────────────────────────────────────┘
```

**Core assumptions**:
- The user device **IS trusted** (precondition: user controls the device)
- The cloud **IS NOT trusted** (may log everything)
- The network path **IS NOT trusted** (MITM-visible)

## 🚨 Threat Categories

### 1. Spoofing

| Threat | Impact | Mitigation |
|---|---|---|
| Attacker forges user request | Unauthorized data access | TEE remote attestation + OHTTP (cloud cannot link) |
| Attacker forges cloud response | Data poisoning | TLS cert verification + response signature (pending S12) |
| Attacker forges policy file | Bypass privacy controls | Policy file HMAC signature (pending S6) |

### 2. Tampering

| Threat | Impact | Mitigation |
|---|---|---|
| Tamper with local storage | Data exfiltration | AES-256-GCM + integrity check |
| Tamper with session history | Inject malicious context | Chained HMAC audit log |
| Tamper with plugin code | Arbitrary code execution | dsh-adapter boundary + signature verification (pending S10) |
| Tamper with network traffic | MITM attack | TLS + OHTTP (double encryption) |

### 3. Repudiation

| Threat | Impact | Mitigation |
|---|---|---|
| User denies an action | Accountability issues | Audit log signature + immutable timestamps |
| Cloud denies a response | Poisoning forensics | Response signature + audit correlation (pending S12) |

### 4. Information Disclosure

| Threat | Impact | Mitigation |
|---|---|---|
| LLM output leaks training data | Privacy breach | Output filtering + redaction (pending S6) |
| Session content leaks to cloud | Context leakage | Realm routing + sanitization |
| OHTTP correlation attack | User profiling | Double OHTTP + timing perturbation (pending S11) |
| Logs leak sensitive info | Side channel | Sensitive field redaction (`DSH_EDGE_AUDIT_SENSITIVE_FIELDS`) |

### 5. Denial of Service

| Threat | Impact | Mitigation |
|---|---|---|
| Malicious input fills local storage | Service unavailable | Quota management + auto-cleanup |
| High-frequency cloud requests | Quota exhaustion | Rate limiting + threat detection |
| Plugin infinite loop | Resource exhaustion | Tool timeout + loop-hygiene |
| OHTTP relay unavailable | Cloud features break | TLS fallback (explicit opt-in) |

### 6. Elevation of Privilege

| Threat | Impact | Mitigation |
|---|---|---|
| Third-party plugin exceeds grant | Data exfiltration | Explicit grant mechanism + plugin sandbox |
| Realm boundary bypass | Data leakage | intent-router enforcement + tool isolation |
| Config file tampering | Privilege escalation | Config file signature (pending S10) |

## 🛡️ Mitigation Details

### 1. TEE (Trusted Execution Environment)

**Goal**: prevent key extraction

**Implementation**:
- All keys (held by `tcm`) live inside the TEE
- Encrypt/decrypt operations execute inside the TEE
- Remote attestation lets the cloud verify the device is trusted

**Supported TEEs**:
- ARM TrustZone (recommended for mobile)
- RISC-V Keystone (recommended for IoT)
- Intel SGX (recommended for servers)
- `simulated` backend (dev only)

### 2. Realm Routing

**Goal**: automatically pick the right data flow

**Implementation**:
- `intent-router` classifies user input and data sensitivity
- Three realms: LOCAL / SANITIZED / CLOUD
- Tools must declare their realm on registration
- Mismatched-realm tools cannot be invoked

### 3. PII Sanitization

**Goal**: replace sensitive info before sending to cloud

**Implementation**:
- `sanitizer-pipeline` detects names, emails, phones, addresses, etc.
- Replaces with tokens (`<NAME_1>`, `<EMAIL_1>`, …)
- Mapping table encrypted locally
- Auto-desanitizes on response

### 4. OHTTP (Oblivious HTTP)

**Goal**: cloud cannot link requests to users

**How it works**:
- Client encrypts request with HPKE public key
- Relay sees only ciphertext, cannot decrypt
- Target sees plaintext but not user identity (relay isolates)
- Double encryption: OHTTP + TLS

**Dependencies**:
- An OHTTP relay
- An OHTTP target (real server)

### 5. Threat Detection

**Goal**: automatically identify anomalous behavior

**Detection rules**:
- High-frequency cloud requests in short window (default 20/min)
- Consecutive sanitization failures (default 3)
- Consecutive permission-denied (default 5)
- Unusual time patterns (e.g. high-frequency requests at 3am)

**Response**:
- `block-cloud`: block all cloud requests
- `kill-session`: terminate the current session
- `notify-user`: notify the user
- `lockdown`: enter locked mode (manual unlock required)

### 6. Audit Log

**Goal**: every action is traceable and immutable

**Implementation**:
- HMAC chain: each entry contains the previous entry's HMAC
- Any tampering breaks the chain
- Periodic flush to encrypted storage
- Alert mechanism: notify user when thresholds are hit

## 🎯 Security Levels

`dsh-edge-agent` provides **three security levels**:

### Level 1: Basic (default)

- Local encrypted storage
- TEE key protection (simulated backend)
- Basic threat detection
- Realm routing

### Level 2: Enhanced (recommended for production)

Enable:
- Real TEE (`DSH_EDGE_TEE_TYPE=trustzone`)
- OHTTP relay (`DSH_EDGE_BRIDGE_MODE=ohttp`)
- Remote attestation (`DSH_EDGE_ATTEST_VERIFIER`)
- Full threat detection (`DSH_EDGE_TD_*`)

### Level 3: Maximum security (sensitive scenarios)

On top of Level 2:
- Disable all cloud calls (`DSH_EDGE_BRIDGE_MODE=tls` + domain deny list)
- Enable TEE inference (`DSH_EDGE_TEE_INFERENCE=true`)
- Lock Realm (force LOCAL only)
- Manually review all third-party plugins

## 📊 Residual Risks

Even with all mitigations in place, the following residual risks remain:

| Risk | Description | User responsibility |
|---|---|---|
| Device physical theft | TEE keys may be stolen | Enable device password + remote wipe |
| User phishing | User voluntarily leaks data | User education + UI warnings |
| Cloud LLM poisoning | The model itself is compromised | Choose trusted models |
| Side channels | Timing, power, etc. | Out of scope for this project |
| Social engineering | User manipulated into authorizing | Strengthen UI warnings |

## 🔗 Related Documentation

- [Architecture](architecture.en.md#security-control-flow)
- [Configuration](configuration.en.md#security-levels)
- [Plugin Development](plugin-development.en.md#security-best-practices)