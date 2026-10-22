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
module.exports = { loadWithVscode, uri, range, item };
