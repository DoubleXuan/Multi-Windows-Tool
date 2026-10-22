const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadWithVscode } = require('../helpers.cjs');
const vscode = {
    Uri: { joinPath: (...parts) => parts.join('/') }, ViewColumn: { Beside: 2 },
    window: { createWebviewPanel: () => ({ webview: {
        asWebviewUri: uri => `http://127.0.0.1:4173/${path.basename(uri)}`,
        cspSource: 'http://127.0.0.1:4173'
    } }) }
};
const { createPanel } = loadWithVscode('webview', vscode);
const html = createPanel({ extensionUri: process.cwd() }, 'Test').webview.html;
const mime = { '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const name = req.url.slice(1);
    if (!['app.js', 'app.css', 'elk.bundled.js'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[path.extname(name)]);
    res.end(fs.readFileSync(path.resolve('out/webview', name)));
}).listen(4173, '127.0.0.1');
