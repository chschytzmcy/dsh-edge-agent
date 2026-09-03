// katex-shim-loader.mjs — minimal CSS stub loader (2026-09-02).
//
// Returns an empty ESM module for any `*.css` import so upstream webui
// imports like `import "katex/dist/katex.min.css"` resolve cleanly under
// Node22 ESM (which would otherwise throw ERR_UNKNOWN_FILE_EXTENSION).
//
// Side effects of the original CSS (font registration, math typesetting)
// are dropped — for our use case (headless edge agent hosting a webui
// for chat) the math rendering quality loss is acceptable. Math
// typography in the chat response panel will degrade to plain text;
// if you need real KaTeX output, host the CSS via dsh-web-app's static
// asset path and let the browser load it via `<link>` instead.

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return {
      url: 'data:text/javascript,export default {}',
      shortCircuit: true,
      format: 'module',
    }
  }
  return nextResolve(specifier, context)
}