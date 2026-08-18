---
name: Bug Report
about: Report a bug in dsh-edge-agent
title: '[bug] '
labels: 'kind/bug'
assignees: ''
---

## Description

A clear and concise description of what the bug is.

## Steps to Reproduce

1. **Environment**:
   - dsh-edge-agent version: (run `dsh-edge-agent --version` or check `package.json`)
   - Node.js version: `node --version`
   - pnpm version: `pnpm --version`
   - OS: (e.g., Ubuntu 22.04, macOS 14.0, Windows 11)
   - DSH CLI version: `dsh --version`

2. **Steps**:
   ```
   $ export DSH_EDGE_TEE_TYPE=simulated
   $ dsh-edge-agent "hello"
   ```

3. **Expected behavior**:
   What you expected to happen.

4. **Actual behavior**:
   What actually happened (include error messages, stack traces, logs).

## Logs

```
[paste relevant logs here]
```

## Configuration

```yaml
# paste your cordis.yml overrides (if any)
```

## Severity

- [ ] Blocker — completely unusable
- [ ] Major — major feature broken
- [ ] Minor — minor inconvenience
- [ ] Cosmetic — UI/UX issue

## Affected Plugins

Check any that apply:
- [ ] tcm
- [ ] local-storage
- [ ] sessions
- [ ] audit-log
- [ ] privacy-policy
- [ ] tools
- [ ] prompt-guard
- [ ] intent-router
- [ ] model-router
- [ ] local-llm-adapter
- [ ] cloud-llm-adapter
- [ ] sanitizer-pipeline
- [ ] ohttp-gateway
- [ ] secure-bridge
- [ ] attestation
- [ ] td-bus
- [ ] local-tools
- [ ] web-search
- [ ] voice-input
- [ ] plugin-host
- [ ] http-api
- [ ] Other (please specify in description)

## Additional Context

Add any other context about the problem here (screenshots, links to related issues, etc.).