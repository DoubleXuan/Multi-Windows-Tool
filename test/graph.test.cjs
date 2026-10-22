const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GraphModel, AsyncCache } = require('../out/graph');
const symbol = id => ({ id, name: id, detail: `${id}.cpp`, uri: `file:///${id}.cpp`, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } });
const relation = (id, parent = 'root') => ({ symbol: symbol(id), sourceId: id, targetId: parent, kind: 'calls', sources: ['callHierarchy'], sites: [] });

test('incoming and outgoing branches have independent request and visibility state', () => {
    const graph = new GraphModel(symbol('root'));
    const incoming = graph.begin('root', 'incoming');
    const outgoing = graph.begin('root', 'outgoing');
    assert.notEqual(incoming, outgoing);
    assert.equal(graph.begin('root', 'incoming'), undefined);
    assert.equal(graph.accept('root', 'incoming', outgoing, [relation('wrong')]), false);
    graph.accept('root', 'incoming', incoming, [relation('caller')]);
    graph.accept('root', 'outgoing', outgoing, [relation('callee')]);
    assert.deepEqual(graph.visible().map(n => n.symbol.id), ['root', 'caller', 'callee']);
    graph.collapse('root', 'incoming');
    assert.deepEqual(graph.visible().map(n => n.symbol.id), ['root', 'callee']);
    assert.equal(graph.begin('root', 'incoming'), undefined);
    assert.deepEqual(graph.visible().map(n => n.symbol.id), ['root', 'caller', 'callee']);
});

test('shared symbols use different path identities and collapse only hides that branch', () => {
    const graph = new GraphModel(symbol('root'));
    graph.accept('root', 'incoming', graph.begin('root', 'incoming'), [relation('a'), relation('b')]);
    const [a, b] = graph.occurrences.get('root').incoming.children;
    for (const id of [a, b]) graph.accept(id, 'incoming', graph.begin(id, 'incoming'), [relation('shared')]);
    const shared = graph.visible().filter(n => n.symbol.id === 'shared');
    assert.equal(shared.length, 2);
    assert.notEqual(shared[0].id, shared[1].id);
    graph.collapse(a, 'incoming');
    assert.equal(graph.visible().filter(n => n.symbol.id === 'shared').length, 1);
});

test('direct and indirect recursion stop at the repeated semantic symbol', () => {
    const graph = new GraphModel(symbol('root'));
    graph.accept('root', 'outgoing', graph.begin('root', 'outgoing'), [relation('root'), relation('b')]);
    const [recursive, b] = graph.occurrences.get('root').outgoing.children;
    assert.equal(graph.occurrences.get(recursive).recursive, true);
    assert.equal(graph.begin(recursive, 'outgoing'), undefined);
    graph.accept(b, 'outgoing', graph.begin(b, 'outgoing'), [relation('root')]);
    assert.equal(graph.visible().at(-1).recursive, true);
});

test('an error can be retried and obsolete responses cannot overwrite the retry', () => {
    const graph = new GraphModel(symbol('root'));
    const first = graph.begin('root', 'incoming');
    graph.fail('root', 'incoming', first, 'offline');
    const retry = graph.begin('root', 'incoming');
    assert.equal(graph.accept('root', 'incoming', first, [relation('stale')]), false);
    graph.accept('root', 'incoming', retry, []);
    assert.equal(graph.occurrences.get('root').incoming.state, 'loaded');
    assert.deepEqual(graph.occurrences.get('root').incoming.children, []);
});

test('a response arriving after collapse stays cached without reopening the branch', () => {
    const graph = new GraphModel(symbol('root'));
    const request = graph.begin('root', 'incoming');
    graph.collapse('root', 'incoming');
    graph.accept('root', 'incoming', request, [relation('late')]);
    assert.equal(graph.visible().length, 1);
    graph.begin('root', 'incoming');
    assert.equal(graph.visible().length, 2);
});

test('cache coalesces requests, retries failures and isolates invalidated in-flight queries', async () => {
    const cache = new AsyncCache();
    let count = 0, finish;
    const first = cache.get('a', () => { count++; return new Promise(resolve => { finish = resolve; }); });
    assert.equal(cache.get('a', () => { throw Error('duplicate'); }), first);
    await Promise.resolve();
    assert.equal(count, 1);
    cache.clear();
    const next = cache.get('a', async () => 'new');
    finish('old');
    assert.equal(await first, 'old');
    assert.equal(await next, 'new');
    assert.equal(await cache.get('a', async () => 'wrong'), 'new');
    await assert.rejects(cache.get('failed', async () => { throw Error('failed'); }));
    assert.equal(await cache.get('failed', async () => 'retried'), 'retried');
});

test('large branches render in batches while retaining all relations for later exploration', () => {
    const graph = new GraphModel(symbol('root'));
    graph.accept('root', 'incoming', graph.begin('root', 'incoming'), Array.from({ length: 55 }, (_, i) => relation(`caller-${i}`)));
    assert.equal(graph.visible().length, 21);
    assert.equal(graph.occurrences.get('root').incoming.children.length, 55);
    graph.showMore('root', 'incoming'); assert.equal(graph.visible().length, 41);
    graph.showMore('root', 'incoming'); assert.equal(graph.visible().length, 56);
});
