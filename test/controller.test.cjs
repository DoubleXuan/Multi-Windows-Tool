const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithVscode, uri, range, item } = require('./helpers.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function signal() {
    const listeners = new Set();
    return { listen: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, fire: event => listeners.forEach(callback => callback(event)) };
}
function setup(execute) {
    const posted = [], changes = signal(), selections = signal(), active = signal();
    const root = item('root', 'root.cpp');
    const editor = { document: { uri: root.uri }, selection: { active: root.selectionRange.start } };
    const disposed = signal();
    const panel = { visible: true, title: '', webview: { cspSource: 'test:', asWebviewUri: value => value,
        postMessage: message => { posted.push(message); return Promise.resolve(true); }, onDidReceiveMessage: signal().listen },
        onDidDispose: disposed.listen, dispose: () => disposed.fire() };
    class Position { constructor(line, character) { this.line = line; this.character = character; } }
    class Range { constructor(sl, sc, el, ec) { this.start = new Position(sl, sc); this.end = new Position(el, ec); } }
    const vscode = {
        Position, Range, Uri: { parse: uri, joinPath: (...parts) => parts.join('/') }, ViewColumn: { Beside: 2, One: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
        commands: { executeCommand: execute || (async command => command === 'vscode.prepareCallHierarchy' ? [root] : []) },
        window: { createWebviewPanel: () => panel, activeTextEditor: undefined,
            onDidChangeTextEditorSelection: selections.listen, onDidChangeActiveTextEditor: active.listen,
            showQuickPick: async options => options[0], showSaveDialog: async () => undefined,
            showTextDocument: async () => { selections.fire({ textEditor: editor, selections: [editor.selection] }); return { revealRange() {} }; } },
        workspace: { asRelativePath: value => value.fsPath, getConfiguration: () => ({ get: (key, fallback) => key === 'followDelay' ? 1 : fallback }),
            onDidChangeTextDocument: changes.listen, onDidCreateFiles: signal().listen, onDidDeleteFiles: signal().listen, onDidRenameFiles: signal().listen,
            openTextDocument: async () => ({ validateRange: value => value }), fs: { writeFile: async () => {} } }
    };
    const { RelationshipViewer } = loadWithVscode('controller', vscode);
    const saved = new Map();
    const context = { extensionUri: 'extension', workspaceState: { get: key => saved.get(key), update: async (key, value) => saved.set(key, value) } };
    const viewer = new RelationshipViewer(context, editor);
    return { viewer, posted, changes, root, editor, selections, active, saved };
}

test('host rejects outdated expansion results after edits and refresh issues a new generation', async () => {
    let finish;
    const root = item('root', 'root.cpp');
    const env = setup(async command => {
        if (command === 'vscode.prepareCallHierarchy') return [root];
        return new Promise(resolve => { finish = resolve; });
    });
    const { viewer, posted, changes } = env;
    await viewer.receive({ type: 'ready' });
    const first = posted.find(m => m.type === 'root');
    const pending = viewer.receive({ type: 'expand', generation: first.generation, requestId: 1, occurrenceId: 'root', symbolId: first.symbol.id, direction: 'incoming' });
    await tick();
    changes.fire({ contentChanges: [{}] });
    finish([{ from: item('late', 'late.cpp'), fromRanges: [range(4)] }]);
    await pending;
    assert.equal(posted.filter(m => m.type === 'children').length, 0);
    assert.equal(posted.filter(m => m.type === 'invalidate').length, 1);
    await viewer.receive({ type: 'refresh' });
    const roots = posted.filter(m => m.type === 'root');
    assert.equal(roots.length, 2); assert.ok(roots[1].generation > roots[0].generation);
    assert.equal(env.saved.get('multiRef.lastSession').root.uri, root.uri.toString());
    viewer.dispose();
});

test('newer symbol resolution wins; same symbol does not reset graph; history can navigate both ways', async () => {
    const a = item('a', 'a.cpp'), b = item('b', 'b.cpp');
    let finishFirst, first = true;
    const { viewer, posted } = setup(async (command, target) => {
        if (command !== 'vscode.prepareCallHierarchy') return [];
        if (first) { first = false; return new Promise(resolve => { finishFirst = resolve; }); }
        return target.toString() === b.uri.toString() ? [b] : [a];
    });
    const pending = viewer.resolve(a.uri, a.selectionRange.start, false);
    await viewer.resolve(b.uri, b.selectionRange.start, false);
    finishFirst([a]); await pending;
    assert.deepEqual(posted.filter(m => m.type === 'root').map(m => m.symbol.name), ['b']);
    await viewer.resolve(b.uri, b.selectionRange.start, false);
    assert.equal(posted.filter(m => m.type === 'root').length, 1);
    await viewer.resolve(a.uri, a.selectionRange.start, false);
    await viewer.receive({ type: 'back' }); await viewer.receive({ type: 'forward' });
    assert.deepEqual(posted.filter(m => m.type === 'root').map(m => m.symbol.name), ['b', 'a', 'b', 'a']);
    viewer.dispose();
});

test('current-symbol action works while Webview has focus, and navigation does not trigger follow loop', async () => {
    let preparations = 0;
    const root = item('root', 'root.cpp');
    const { viewer, posted } = setup(async command => { if (command === 'vscode.prepareCallHierarchy') { preparations++; return [root]; } return []; });
    await viewer.receive({ type: 'ready' });
    await viewer.receive({ type: 'current' });
    assert.equal(preparations, 2);
    await viewer.receive({ type: 'follow', value: true });
    const symbol = posted.find(m => m.type === 'root').symbol;
    await viewer.receive({ type: 'open', location: { uri: symbol.uri, range: symbol.range } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(preparations, 2);
    viewer.dispose();
});
