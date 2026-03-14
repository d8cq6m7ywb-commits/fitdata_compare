const esbuild = require('esbuild');
const { polyfillNode } = require('esbuild-plugin-polyfill-node');

esbuild.build({
  entryPoints: ['src/parser-wrapper.js'],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'FitEntry',
  outfile: 'fit-entry.js',
  plugins: [polyfillNode()],
}).then(() => {
  console.log('Parser bundle built → fit-entry.js');
}).catch(() => process.exit(1));
