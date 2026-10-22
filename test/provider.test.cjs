const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithVscode, item, range } = require('./helpers.cjs');

test('provider retains opaque items, groups call sites, and keeps outgoing locations in the caller file', async () => {
    const root = item('root', 'root.cpp'), caller = item('caller', 'caller.cpp'), callee = item('callee', 'callee.cpp');
    let incomingQueries = 0;
    const vscode = {
        workspace: { asRelativePath: uri => uri.fsPath.slice(1) },
        commands: { executeCommand: async (command, target) => {
            if (command === 'vscode.prepareCallHierarchy') return [root];
            assert.equal(target, root);
            if (command === 'vscode.provideIncomingCalls') {
                incomingQueries++;
                return [{ from: caller, fromRanges: [range(4), range(9)] }, { from: caller, fromRanges: [range(9), range(15)] }];
            }
            if (command === 'vscode.provideOutgoingCalls') return [{ to: callee, fromRanges: [range(30)] }];
            throw Error(command);
        } }
    };
    const { CallGraphProvider } = loadWithVscode('provider', vscode);
    const provider = new CallGraphProvider();
    const [symbol] = await provider.prepare(root.uri, root.selectionRange.start);
    const [incoming, cached, outgoing] = await Promise.all([provider.query(symbol.id, 'incoming'), provider.query(symbol.id, 'incoming'), provider.query(symbol.id, 'outgoing')]);
    assert.equal(incomingQueries, 1);
    assert.equal(incoming, cached);
    assert.equal(incoming.length, 1);
    assert.deepEqual(incoming[0].sites.map(s => s.range.start.line), [4, 9, 15]);
    assert.equal(incoming[0].callerId, incoming[0].symbol.id);
    assert.equal(incoming[0].calleeId, symbol.id);
    assert.equal(incoming[0].sites[0].uri, caller.uri.toString());
    assert.equal(outgoing[0].sites[0].uri, root.uri.toString());
    assert.equal(outgoing[0].callerId, symbol.id);
    assert.equal(outgoing[0].calleeId, outgoing[0].symbol.id);
    provider.invalidate(); provider.register(root); await provider.query(symbol.id, 'incoming');
    assert.equal(incomingQueries, 2);
});

test('invalidated provider queries cannot repopulate the registry with outdated opaque items', async () => {
    let finish;
    const root = item('root', 'root.cpp'), late = item('late', 'late.cpp');
    const vscode = { workspace: { asRelativePath: value => value.fsPath }, commands: { executeCommand: async () => new Promise(resolve => { finish = resolve; }) } };
    const { CallGraphProvider, symbolKey } = loadWithVscode('provider', vscode);
    const provider = new CallGraphProvider(); const symbol = provider.register(root);
    const pending = provider.query(symbol.id, 'outgoing');
    await Promise.resolve();
    provider.invalidate(); provider.register(root);
    finish([{ to: late, fromRanges: [range(5)] }]);
    await assert.rejects(pending, /代码已变化/);
    await assert.rejects(provider.query(symbolKey(late), 'incoming'), /失效/);
});

test('provider distinguishes same-name functions and handles empty results and retryable failure', async () => {
    const a = item('same', 'a.cpp'), b = item('same', 'b.cpp'), overload = item('same', 'a.cpp', 10);
    let fail = true;
    const vscode = { workspace: { asRelativePath: uri => uri.fsPath }, commands: { executeCommand: async command => {
        if (command === 'vscode.prepareCallHierarchy') return undefined;
        if (fail) { fail = false; throw Error('language server unavailable'); }
        return undefined;
    } } };
    const { CallGraphProvider, symbolKey } = loadWithVscode('provider', vscode);
    assert.notEqual(symbolKey(a), symbolKey(b)); assert.notEqual(symbolKey(a), symbolKey(overload));
    const provider = new CallGraphProvider(); const root = provider.register(a);
    assert.deepEqual(await provider.prepare(a.uri, a.selectionRange.start), []);
    await assert.rejects(provider.query(root.id, 'incoming'), /unavailable/);
    assert.deepEqual(await provider.query(root.id, 'incoming'), []);
    provider.dispose();
    await assert.rejects(provider.query(root.id, 'incoming'), /失效/);
});
