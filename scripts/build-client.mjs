import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/client-plugin.mjs'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@deepseek-ai/dsh-client-runtime/client'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  banner: { js: 'window.__ModuleLoader__.load({ id: "@harzva/dsh-terminal", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
  plugins: [{
    name: 'owned-css-text',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, async ({ path: filename }) => {
        let css = await readFile(filename, 'utf8');
        if (filename.includes(`${path.sep}@xterm${path.sep}`)) {
          css = `@scope (.dsh-terminal-workspace) {\n${css}\n}`;
        }
        return { contents: css, loader: 'text' };
      });
    },
  }],
});
