/**
 * dsh-edge-agent — main entry. The `name='dsh-edge-agent'` plugin
 * is the aggregator that mounts every sub-plugin declared in
 * `cordis.yml`. Re-exported from the adapter boundary.
 *
 * @module dsh-edge-agent
 */

export * from './dsh-adapter/index.js'
export { default } from './dsh-adapter/index.js'