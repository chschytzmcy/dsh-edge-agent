---
name: Feature Request
about: Suggest a new feature or enhancement for dsh-edge-agent
title: '[feature] '
labels: 'kind/feature'
assignees: ''
---

## Summary

A clear and concise description of the feature you want.

## Motivation

Why is this feature needed? What problem does it solve?

## Proposed Solution

How should the feature work? Describe the API, configuration, and behavior.

### Example API

```typescript
// Example: how a user would use the feature
import { myNewPlugin } from '@deepseek-harness-edge-agent/dsh-edge-agent/my-new-plugin'
```

### Example Configuration

```yaml
# Example cordis.yml snippet
- id: my-new-plugin
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/my-new-plugin'
  config:
    myOption: 'value'
```

### Example Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DSH_EDGE_MY_OPTION` | `''` | My new option |

## Alternatives Considered

What other approaches did you consider, and why is this one better?

## Affected Plugins

Does this feature interact with existing plugins? List them.

- [ ] Adds a new plugin
- [ ] Modifies existing plugin(s): ______
- [ ] Affects the adapter boundary
- [ ] Requires upstream DSH changes

## Security Implications

Does this feature affect:
- [ ] Data at rest (encrypted storage)
- [ ] Data in transit (OHTTP/TLS)
- [ ] TEE usage
- [ ] Realm routing
- [ ] Audit logging
- [ ] Threat detection

If yes, please describe:

## Breaking Changes

Is this a breaking change?
- [ ] No (additive)
- [ ] Yes (please describe migration path)

## Related Issues

Link any related issues or discussions.

## Additional Context

Anything else we should know (screenshots, examples, references).