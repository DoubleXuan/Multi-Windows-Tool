const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithVscode, item, range, span, uri, textDocument, providerMock } = require('./helpers.cjs');
const indexed = (name, kind, fullRange, selectionRange, children = []) => ({ name, kind, range: fullRange, selectionRange, children });

test('native calls retain opaque items, group call sites, and keep outgoing locations in the caller file', async () => {
    const root = item('root', 'root.cpp'), caller = item('caller', 'caller.cpp'), callee = item('callee', 'callee.cpp');
    let incomingQueries = 0;
    const { vscode } = providerMock(async (command, target) => {
        if (command === 'vscode.prepareCallHierarchy') return [root];
        if (command === 'vscode.provideIncomingCalls') {
            assert.equal(target, root); incomingQueries++;
            return [{ from: caller, fromRanges: [range(4), range(9)] }, { from: caller, fromRanges: [range(9), range(15)] }];
        }
        if (command === 'vscode.provideOutgoingCalls') { assert.equal(target, root); return [{ to: callee, fromRanges: [range(30)] }]; }
        return [];
    });
    const { CallGraphProvider } = loadWithVscode('provider', vscode);
    const provider = new CallGraphProvider();
    const [symbol] = await provider.prepare(root.uri, root.selectionRange.start);
    const [incoming, cached, outgoing] = await Promise.all([provider.queryResult(symbol.id, 'incoming', 'calls'), provider.queryResult(symbol.id, 'incoming', 'calls'), provider.queryResult(symbol.id, 'outgoing', 'calls')]);
    assert.equal(incomingQueries, 1); assert.equal(incoming, cached);
    assert.equal(incoming.relations.length, 1);
    assert.deepEqual(incoming.relations[0].sites.map(s => s.range.start.line), [4, 9, 15]);
    assert.equal(incoming.relations[0].sourceId, incoming.relations[0].symbol.id);
    assert.equal(incoming.relations[0].targetId, symbol.id);
    assert.equal(incoming.relations[0].sites[0].uri, caller.uri.toString());
    assert.equal(outgoing.relations[0].sites[0].uri, root.uri.toString());
    assert.equal(outgoing.relations[0].sourceId, symbol.id);
    provider.invalidate(); provider.register(root); await provider.queryResult(symbol.id, 'incoming', 'calls');
    assert.equal(incomingQueries, 2);
});

test('macro selected inside a function survives empty/wrong call hierarchy and retains every native reference', async () => {
    const header = textDocument('api.h', '#define READ(x) read_impl(x)');
    const source = textDocument('use.cpp', 'void load() {\n  READ(dev);\n}');
    const refs = [{ uri: source.uri, range: span(1, 2, 1, 6) }, { uri: header.uri, range: span(0, 8, 0, 12) }];
    const { vscode, requests } = providerMock(async (command, target, position) => {
        if (command === 'vscode.prepareCallHierarchy') return [item('load', 'use.cpp', 0)];
        if (command === 'vscode.executeDefinitionProvider') return [{ targetUri: header.uri, targetRange: span(0, 0, 0, 27), targetSelectionRange: span(0, 8, 0, 12) }];
        if (command === 'vscode.executeReferenceProvider') {
            assert.equal(target.toString(), source.uri.toString()); assert.deepEqual(position, new vscode.Position(1, 3)); return refs;
        }
        if (command === 'vscode.executeDocumentSymbolProvider' && target.toString() === source.uri.toString()) return [indexed('load', 11, span(0, 0, 2, 1), span(0, 5, 0, 9))];
        return [];
    }, [header, source]);
    const { CallGraphProvider } = loadWithVscode('provider', vscode);
    const provider = new CallGraphProvider();
    const [macro] = await provider.prepare(source.uri, { line: 1, character: 3 });
    assert.equal(macro.name, 'READ'); assert.equal(macro.category, 'macro'); assert.equal(macro.uri, header.uri.toString());
    assert.equal(macro.capabilities.calls, false);
    const result = await provider.queryResult(macro.id, 'incoming', 'auto');
    assert.equal(result.relations.reduce((sum, relation) => sum + relation.sites.length, 0), refs.length);
    assert.deepEqual(result.relations.map(r => r.kind).sort(), ['declaration', 'references']);
    assert.equal(result.relations.find(r => r.kind === 'references').symbol.name, 'load');
    assert.equal(requests.filter(r => r.command === 'vscode.provideIncomingCalls').length, 0);
});

test('struct members expose typed contains edges, then field references include calls and assignments without inventing bindings', async () => {
    const doc = textDocument('ops.cpp', 'struct Ops {\n int (*read)();\n};\nvoid use() {\n ops.read();\n ops.read = impl;\n}');
    const field = indexed('read', 7, span(1, 0, 1, 15), span(1, 7, 1, 11));
    const type = indexed('Ops', 22, span(0, 0, 2, 2), span(0, 7, 0, 10), [field]);
    const owner = indexed('use', 11, span(3, 0, 6, 1), span(3, 5, 3, 8));
    const refs = [{ uri: doc.uri, range: span(4, 5, 4, 9) }, { uri: doc.uri, range: span(5, 5, 5, 9) }];
    const { vscode } = providerMock(async (command, _uri, position) => {
        if (command === 'vscode.executeDocumentSymbolProvider') return [type, owner];
        if (command === 'vscode.executeReferenceProvider') { assert.equal(position.line, 1); return refs; }
        return [];
    }, [doc]);
    const { CallGraphProvider } = loadWithVscode('provider', vscode);
    const provider = new CallGraphProvider();
    const [root] = await provider.prepare(doc.uri, { line: 0, character: 8 });
    assert.equal(root.category, 'type');
    const members = await provider.queryResult(root.id, 'outgoing', 'auto');
    assert.equal(members.relations.length, 1); assert.equal(members.relations[0].kind, 'contains');
    const member = members.relations[0].symbol; assert.equal(member.category, 'field');
    const usages = await provider.queryResult(member.id, 'incoming', 'auto');
    assert.equal(usages.relations.length, 1); assert.equal(usages.relations[0].kind, 'references');
    assert.equal(usages.relations[0].sites.length, 2); assert.equal(usages.relations[0].symbol.name, 'use');
});

test('auto mode supplements native calls with references but never turns address-taking into a confirmed call', async () => {
    const root = item('target', 'api.h', 0), caller = item('invoke', 'use.cpp', 0);
    const callSite = span(1, 2, 1, 10), refSite = span(1, 2, 1, 8), addressSite = span(4, 12, 4, 18);
    const source = textDocument('use.cpp', 'void invoke() {\n  target();\n}\n\nauto ptr = &target;');
    const { vscode } = providerMock(async command => {
        if (command === 'vscode.provideIncomingCalls') return [{ from: caller, fromRanges: [callSite] }];
        if (command === 'vscode.executeReferenceProvider') return [{ uri: source.uri, range: refSite }, { uri: source.uri, range: span(1, 2, 1, 9) }, { uri: source.uri, range: addressSite }];
        if (command === 'vscode.executeDocumentSymbolProvider') return [indexed('invoke', 11, span(0, 0, 2, 1), span(0, 5, 0, 11)), indexed('ptr', 12, span(4, 0, 4, 19), span(4, 5, 4, 8))];
        return [];
    }, [source]);
    const { CallGraphProvider } = loadWithVscode('provider', vscode); const provider = new CallGraphProvider(); const symbol = provider.register(root);
    const auto = await provider.queryResult(symbol.id, 'incoming', 'auto');
    assert.equal(auto.relations.length, 2);
    const call = auto.relations.find(r => r.kind === 'calls');
    assert.deepEqual(call.sites[0].range, refSite); assert.deepEqual(call.sources, ['callHierarchy', 'references']);
    assert.equal(call.sites.length, 2);
    assert.equal(auto.relations.find(r => r.kind === 'references').symbol.name, 'ptr');
    const refs = await provider.queryResult(symbol.id, 'incoming', 'references');
    assert.equal(refs.relations.filter(r => r.kind === 'calls').length, 0);
});

test('reference-only symbols work with no definition or document symbols, and failing owner lookup never drops locations', async () => {
    const source = textDocument('entry.cpp', 'MAGIC();');
    const { vscode } = providerMock(async command => {
        if (command === 'vscode.executeReferenceProvider') return [{ uri: uri('file:///missing.cpp'), range: range(42) }];
        if (command === 'vscode.executeDocumentSymbolProvider') throw Error('no symbols');
        return [];
    }, [source]);
    const { CallGraphProvider } = loadWithVscode('provider', vscode); const provider = new CallGraphProvider();
    const [symbol] = await provider.prepare(source.uri, { line: 0, character: 1 });
    assert.equal(symbol.name, 'MAGIC');
    const result = await provider.queryResult(symbol.id, 'incoming', 'auto');
    assert.equal(result.relations[0].symbol.category, 'location'); assert.equal(result.relations[0].sites[0].range.start.line, 42);
    assert.ok(result.notices.length);
});

test('query failure offers retry and invalidated queries cannot register stale call or reference owners', async () => {
    const root = item('root', 'root.cpp'), late = item('late', 'late.cpp');
    let finish, fail = true;
    const { vscode } = providerMock(async command => {
        if (command === 'vscode.provideOutgoingCalls') {
            if (fail) { fail = false; throw Error('temporarily unavailable'); }
            return new Promise(resolve => { finish = resolve; });
        }
        return [];
    });
    const { CallGraphProvider, symbolKey } = loadWithVscode('provider', vscode); const provider = new CallGraphProvider(); const symbol = provider.register(root);
    await assert.rejects(provider.queryResult(symbol.id, 'outgoing', 'calls'), /temporarily/);
    const pending = provider.queryResult(symbol.id, 'outgoing', 'calls'); await Promise.resolve(); await Promise.resolve();
    provider.invalidate(); provider.register(root); finish([{ to: late, fromRanges: [range(5)] }]);
    await assert.rejects(pending, /代码已变化/); await assert.rejects(provider.query(symbolKey(late), 'incoming'), /失效/);
});

test('same-name symbols remain distinct and a missing call provider falls back to reference queries', async () => {
    const a = item('same', 'a.cpp'), b = item('same', 'b.cpp'), overload = item('same', 'a.cpp', 10);
    const { vscode } = providerMock(async command => {
        if (command === 'vscode.provideIncomingCalls') throw Error('call hierarchy unsupported');
        if (command === 'vscode.executeReferenceProvider') return [{ uri: uri('file:///use.cpp'), range: range(2) }];
        return [];
    });
    const { CallGraphProvider, symbolKey } = loadWithVscode('provider', vscode);
    assert.notEqual(symbolKey(a), symbolKey(b)); assert.notEqual(symbolKey(a), symbolKey(overload));
    const provider = new CallGraphProvider(); const root = provider.register(a);
    const result = await provider.queryResult(root.id, 'incoming', 'auto');
    assert.equal(result.relations[0].kind, 'references'); assert.match(result.notices[0], /调用层级查询失败/);
    provider.dispose(); await assert.rejects(provider.query(root.id, 'incoming'), /失效/);
});

test('an in-flight reference lookup is rejected after invalidation and does not register obsolete owners', async () => {
    let finish;
    const root = item('root', 'root.cpp');
    const { vscode } = providerMock(async command => command === 'vscode.executeReferenceProvider' ? new Promise(resolve => { finish = resolve; }) : []);
    const { CallGraphProvider } = loadWithVscode('provider', vscode); const provider = new CallGraphProvider();
    const symbol = provider.register(root);
    const pending = provider.queryResult(symbol.id, 'incoming', 'references'); await Promise.resolve(); await Promise.resolve();
    provider.invalidate(); finish([{ uri: uri('file:///obsolete.cpp'), range: range(10) }]);
    await assert.rejects(pending, /代码已变化/);
    await assert.rejects(provider.query('file:file:///obsolete.cpp', 'incoming'), /失效/);
});

test('macro body dependencies require successful definition resolution, skip parameters and can continue through nested macros', async () => {
    const doc = textDocument('macros.h', '#define INNER(x) impl(x)\n#define OUTER(x) INNER(x) + NO_DEFINITION + "fake()"\nint impl(int x);');
    const { vscode, requests } = providerMock(async (command, _uri, position) => {
        if (command === 'vscode.executeDefinitionProvider') {
            if (position.line === 1 && position.character === 17) return [{ uri: doc.uri, range: span(0, 8, 0, 13) }];
            if (position.line === 0 && position.character === 17) return [{ uri: doc.uri, range: span(2, 4, 2, 8) }];
            return [];
        }
        if (command === 'vscode.executeDocumentSymbolProvider') return [indexed('impl', 11, span(2, 0, 2, 16), span(2, 4, 2, 8))];
        return [];
    }, [doc]);
    const { CallGraphProvider } = loadWithVscode('provider', vscode); const provider = new CallGraphProvider();
    const [outer] = await provider.prepare(doc.uri, { line: 1, character: 9 });
    assert.equal(outer.capabilities.dependencies, true);
    const dependencies = await provider.queryResult(outer.id, 'outgoing', 'auto');
    assert.equal(dependencies.relations.length, 1);
    const inner = dependencies.relations[0];
    assert.equal(inner.symbol.name, 'INNER'); assert.equal(inner.kind, 'references'); assert.deepEqual(inner.sources, ['definitions']);
    assert.equal(inner.sourceId, outer.id); assert.equal(inner.targetId, inner.symbol.id);
    const nested = await provider.queryResult(inner.symbol.id, 'outgoing', 'auto');
    assert.equal(nested.relations[0].symbol.name, 'impl'); assert.equal(nested.relations[0].symbol.category, 'function');
    assert.equal(requests.some(request => request.command === 'vscode.executeDefinitionProvider' && request.args[1].character === 23 && request.args[1].line === 1), false);
});
