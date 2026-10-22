const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanMacro } = require('../out/cpp-macro');

test('macro candidates exclude parameters, comments, strings and token-paste/stringify operands', () => {
    const text = '#define READ(x, ...) helper(x, __VA_ARGS__) + NEXT + "fake()" + u8"other()" + \'c\' /* hidden() */ + prefix ## suffix + #x';
    const result = scanMacro(text, 0);
    assert.equal(result.name, 'READ');
    assert.deepEqual(result.identifiers.map(token => token.name), ['helper', 'NEXT']);
    for (const token of result.identifiers) assert.equal(text.slice(token.range.start.character, token.range.end.character), token.name);
});

test('line splicing preserves physical token positions and happens before comment recognition', () => {
    const text = '#define CHAIN(x) \\\n  helper(x) + NEXT // continued comment \\\n  never_a_dependency()';
    const result = scanMacro(text, 0);
    assert.deepEqual(result.identifiers.map(token => token.name), ['helper', 'NEXT']);
    assert.deepEqual(result.identifiers[0].range, { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } });
});

test('raw literals and comments in parameter lists do not create dependencies; member spelling is retained for semantic lookup', () => {
    const result = scanMacro('#define M(x /* ) */) R"tag(fake("call"))tag" + x.member + REAL', 0);
    assert.deepEqual(result.identifiers.map(token => token.name), ['member', 'REAL']);
    assert.equal(scanMacro('void function() {}', 0), undefined);
    const bounded = scanMacro('#define M A B C D', 0, 2);
    assert.equal(bounded.truncated, true); assert.deepEqual(bounded.identifiers.map(token => token.name), ['A', 'B']);
});
