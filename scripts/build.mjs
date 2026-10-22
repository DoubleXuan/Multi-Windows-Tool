import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('out/webview', { recursive: true });
await build({ entryPoints: ['webview/app.ts'], outfile: 'out/webview/app.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2020', sourcemap: true });
await Promise.all([
    copyFile('webview/app.css', 'out/webview/app.css'),
    copyFile('node_modules/elkjs/lib/elk.bundled.js', 'out/webview/elk.bundled.js'),
    copyFile('node_modules/elkjs/LICENSE.md', 'out/webview/ELK-LICENSE.md')
]);
