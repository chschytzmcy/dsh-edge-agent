// katex-shim.js — 2026-09-02: CSS loader shim for webui-based profiles.
//
// @deepseek-ai/dsh-client-ui-attachment (and a few other upstream webui
// plugins) do `import "katex/dist/katex.min.css"`. Node22 ESM rejects
// unstubbed `.css` requires with ERR_UNKNOWN_FILE_EXTENSION on boot.
//
// Workaround: register a tiny custom resolver that returns an empty
// ESM module for any `*.css` import path. Wired via
// `NODE_OPTIONS=--import ./katex-shim.js` in the dsh launch wrapper.
//
// Usage (in your web profile launcher):
//   NODE_OPTIONS='--import /home/etsme/cy/agent/dsh-edge-agent/katex-shim.js' \
//     dsh --profile web --port 3080
// §7.43 (2026-09-05): katex-shim 是 webui 专用，仅 web profile 需要；dsh-tui
// 不加载。TUI profile 默认 launcher 不需要这个 NODE_OPTIONS。
//
// 2026-09-02: initial shim. See PROGRESS §7.25.
import { register } from 'node:module'

// `new URL(relative, import.meta.url).href` resolves to an absolute file://
// URL string. `register()` accepts the URL string directly.
// 2026-09-02: initial impl wrapped this in pathToFileURL(URL) which
// ERR_INVALID_ARG_TYPEs because pathToFileURL expects a string path,
// not a URL object. Fixed by skipping the redundant conversion.
register(new URL('./katex-shim-loader.mjs', import.meta.url).href)