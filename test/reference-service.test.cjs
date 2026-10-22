const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithVscode, uri, range, textDocument, providerMock } = require('./helpers.cjs');

test('references keep unreadable files and stale line positions instead of rejecting the whole result', async () => {
    const good = textDocument('good.cpp', 'call();');
    const { vscode } = providerMock(async () => [], [good]);
    const { referenceGroups } = loadWithVscode('reference-service', vscode);
    const refs = [
        { uri: good.uri, range: range(0) },
        { uri: good.uri, range: range(99) },
        { uri: uri('file:///missing.cpp'), range: range(3) }
    ];
    const result = await referenceGroups(refs);
    assert.equal(result.groups.length, 2);
    assert.equal(result.groups.flatMap(group => group.items).length, 3);
    assert.equal(result.groups[0].items[0].text, 'call();');
    assert.equal(result.groups[0].items[1].range.start.line, 99);
    assert.equal(result.groups[1].items[0].uri, 'file:///missing.cpp');
    assert.equal(result.notices.length, 2);
});

test('native reference query preserves exact URI/position and deduplicates repeated provider locations', async () => {
    const logs = [];
    const target = uri('file:///header.h'), position = { line: 7, character: 11 };
    const ref = { uri: uri('file:///use.cpp'), range: range(10) };
    const { vscode } = providerMock(async (command, queryUri, queryPosition) => {
        assert.equal(command, 'vscode.executeReferenceProvider');
        assert.equal(queryUri.toString(), target.toString()); assert.equal(queryPosition, position);
        return [ref, ref];
    });
    const { queryReferences } = loadWithVscode('reference-service', vscode);
    const result = await queryReferences(target, position, message => logs.push(message));
    assert.equal(result.length, 1); assert.match(logs[0], /position=7:11 count=1/);
});
