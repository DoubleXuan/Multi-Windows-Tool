const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function loadWithVscode(name, vscode, cache = new Map()) {
    const file = path.resolve(__dirname, '../out', name.endsWith('.js') ? name : `${name}.js`);
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    const localRequire = id => id === 'vscode' ? vscode : id.startsWith('.') ? loadWithVscode(path.resolve(path.dirname(file), id), vscode, cache) : require(id);
    vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
}
const uri = value => ({ toString: () => value, fsPath: value.replace('file://', '') });
const range = (line, character = 0) => ({ start: { line, character }, end: { line, character: character + 3 } });
const item = (name, file, line = 1) => ({ name, uri: uri(`file:///${file}`), kind: 11, selectionRange: range(line), range: range(line), _opaque: { name } });
const span = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
class Position { constructor(line, character) { this.line = line; this.character = character; } }
function textDocument(file, text) {
    const lines = text.split('\n');
    return { uri: uri(`file:///${file}`), languageId: 'cpp', version: 1,
        lineAt: line => { if (!lines[line] && lines[line] !== '') throw Error('line out of range'); return { text: lines[line] }; },
        getText: range => range ? lines[range.start.line].slice(range.start.character, range.end.character) : text,
        getWordRangeAtPosition: pos => {
            for (const match of (lines[pos.line] || '').matchAll(/[A-Za-z_]\w*/g)) {
                if (match.index <= pos.character && pos.character < match.index + match[0].length) return span(pos.line, match.index, pos.line, match.index + match[0].length);
            }
        }
    };
}
function providerMock(handler, docs = []) {
    const documents = new Map(docs.map(doc => [doc.uri.toString(), doc]));
    const requests = [];
    const vscode = {
        Uri: { parse: uri }, Position,
        workspace: { asRelativePath: value => value.fsPath.slice(1), openTextDocument: async value => {
            const doc = documents.get(value.toString()); if (!doc) throw Error(`unreadable ${value}`); return doc;
        } },
        commands: { executeCommand: async (command, ...args) => { requests.push({ command, args }); return handler(command, ...args); } }
    };
    return { vscode, requests, documents };
}
module.exports = { loadWithVscode, uri, range, item, span, Position, textDocument, providerMock };
