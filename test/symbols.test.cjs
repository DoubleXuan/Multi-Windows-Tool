const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithVscode, providerMock, span, uri } = require('./helpers.cjs');

test('flat symbol providers infer immediate parents from full ranges rather than ambiguous container names', async () => {
    const file = uri('file:///types.cpp');
    const flat = (name, kind, sl, el) => ({ name, kind, containerName: 'Same', location: { uri: file, range: span(sl, 0, el, 50) } });
    const { vscode } = providerMock(async () => [flat('Same', 22, 0, 100), flat('method', 5, 10, 50), flat('local', 12, 20, 20), flat('Same', 22, 110, 200), flat('field', 7, 120, 120)]);
    const { DocumentIndex } = loadWithVscode('symbols', vscode);
    const result = await new DocumentIndex(() => {}).get(file);
    const [first, second] = result.filter(item => item.name === 'Same');
    assert.deepEqual(first.children.map(item => item.name), ['method']);
    assert.deepEqual(first.children[0].children.map(item => item.name), ['local']);
    assert.deepEqual(second.children.map(item => item.name), ['field']);
});

test('hierarchical symbols preserve their explicit immediate children and index queries share a cache', async () => {
    const file = uri('file:///types.cpp'); let queries = 0;
    const field = { name: 'field', kind: 7, range: span(1, 0, 1, 10), selectionRange: span(1, 4, 1, 9), children: [] };
    const type = { name: 'Type', kind: 22, range: span(0, 0, 2, 1), selectionRange: span(0, 7, 0, 11), children: [field] };
    const { vscode } = providerMock(async () => { queries++; return [type]; });
    const { DocumentIndex } = loadWithVscode('symbols', vscode); const index = new DocumentIndex(() => {});
    const first = await index.get(file); const second = await index.get(file);
    assert.equal(queries, 1); assert.equal(first, second); assert.equal(first[0].children.length, 1);
    index.clear(); await index.get(file); assert.equal(queries, 2);
});
