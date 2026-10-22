import * as vscode from 'vscode';
import { CallGraphProvider } from './provider';
import { CodeLocation, HostMessage, SymbolData } from './protocol';
import { createPanel, openLocation, validLocation } from './webview';

export class RelationshipViewer implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private readonly provider = new CallGraphProvider();
    private readonly disposables: vscode.Disposable[] = [];
    private generation = 0;
    private resolution = 0;
    private root?: SymbolData;
    private history: SymbolData[] = [];
    private historyIndex = -1;
    private follow = vscode.workspace.getConfiguration('multiRef').get('followEditor', false);
    private timer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private dirty = false;
    private suppressFollow = 0;
    private allowed = new Set<string>();
    private anchor?: { uri: vscode.Uri; position: vscode.Position };
    private lastEditor?: vscode.TextEditor;

    constructor(private readonly context: vscode.ExtensionContext, initial?: vscode.TextEditor, existing?: vscode.WebviewPanel, saved?: unknown) {
        this.lastEditor = initial || vscode.window.activeTextEditor;
        if (initial) this.anchor = { uri: initial.document.uri, position: initial.selection.active };
        else {
            const session = (saved || context.workspaceState.get('multiRef.lastSession')) as { root?: CodeLocation; follow?: boolean } | undefined;
            if (validLocation(session?.root)) this.anchor = { uri: vscode.Uri.parse(session.root.uri), position: new vscode.Position(session.root.range.start.line, session.root.range.start.character) };
            if (typeof session?.follow === 'boolean') this.follow = session.follow;
        }
        this.panel = createPanel(context, '调用关系', existing);
        this.disposables.push(this.panel.webview.onDidReceiveMessage((msg: unknown) => { void this.receive(msg).catch(e => this.status(String(e))); }));
        this.disposables.push(this.panel.onDidDispose(() => this.dispose()));
        this.disposables.push(vscode.window.onDidChangeTextEditorSelection(event => {
            this.lastEditor = event.textEditor;
            if (!this.follow || Date.now() < this.suppressFollow || !this.panel.visible) return;
            this.schedule(event.textEditor.document.uri, event.selections[0].active);
        }));
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) this.lastEditor = editor;
            if (editor && this.follow && Date.now() >= this.suppressFollow && this.panel.visible) this.schedule(editor.document.uri, editor.selection.active);
        }));
        const invalidate = () => {
            if (this.disposed) return;
            this.dirty = true;
            this.provider.invalidate();
            ++this.resolution;
            // Existing in-flight results belong to an older workspace snapshot.
            ++this.generation;
            this.post({ type: 'invalidate', generation: this.generation });
            this.status('代码已变化，当前图可能过期。请刷新以重新查询调用关系。');
        };
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) invalidate(); }));
        this.disposables.push(vscode.workspace.onDidCreateFiles(invalidate), vscode.workspace.onDidDeleteFiles(invalidate), vscode.workspace.onDidRenameFiles(invalidate));
    }
    private post(message: HostMessage | { type: 'invalidate'; generation: number }) {
        if (!this.disposed) void this.panel.webview.postMessage(message);
    }
    private status(message: string) { this.post({ type: 'status', message }); }
    private authorize(target: CodeLocation) { this.allowed.add(JSON.stringify(target)); }
    private schedule(uri: vscode.Uri, position: vscode.Position) {
        clearTimeout(this.timer);
        // Invalidate a previous resolution as soon as the cursor moves.
        ++this.resolution;
        const delay = vscode.workspace.getConfiguration('multiRef').get<number>('followDelay', 350);
        this.timer = setTimeout(() => { void this.resolve(uri, position, false); }, delay);
    }
    private async resolve(uri: vscode.Uri, position: vscode.Position, choose: boolean, refresh = false) {
        clearTimeout(this.timer);
        const ticket = ++this.resolution;
        this.status('正在解析符号…');
        try {
            const symbols = await this.provider.prepare(uri, position);
            if (this.disposed || ticket !== this.resolution) return;
            if (!symbols.length) {
                this.status('此位置没有可用的调用层级。请选中函数，并确认语言扩展已启用且完成索引。');
                return;
            }
            let symbol = symbols[0];
            if (choose && symbols.length > 1) {
                const choice = await vscode.window.showQuickPick(symbols.map(s => ({ label: s.name, description: s.detail, symbol: s })), { placeHolder: '选择调用关系的根符号' });
                if (!choice || ticket !== this.resolution) { if (ticket === this.resolution) this.status(''); return; }
                symbol = choice.symbol;
            }
            this.anchor = { uri, position };
            if (!refresh && !this.dirty && symbol.id === this.root?.id) { this.status(''); return; }
            this.dirty = false;
            if (refresh && this.historyIndex >= 0) this.history[this.historyIndex] = symbol;
            else {
                this.history = this.history.slice(0, this.historyIndex + 1);
                this.history.push(symbol);
                if (this.history.length > 100) this.history.shift();
                this.historyIndex = this.history.length - 1;
            }
            this.setRoot(symbol);
        } catch (error) { if (ticket === this.resolution) this.status(`解析失败：${String(error)}`); }
    }
    private setRoot(symbol: SymbolData) {
        this.root = symbol;
        ++this.generation;
        this.allowed.clear();
        this.authorize({ uri: symbol.uri, range: symbol.range });
        this.panel.title = `关系: ${symbol.name}`;
        this.persist();
        this.post({ type: 'root', generation: this.generation, symbol, follow: this.follow, canBack: this.historyIndex > 0, canForward: this.historyIndex < this.history.length - 1 });
    }
    private persist() {
        if (this.root) void this.context.workspaceState.update('multiRef.lastSession', { root: { uri: this.root.uri, range: this.root.range }, follow: this.follow });
    }
    private async receive(value: unknown) {
        if (!value || typeof value !== 'object' || this.disposed) return;
        const msg = value as Record<string, unknown>;
        switch (msg.type) {
            case 'ready':
                if (this.anchor) await this.resolve(this.anchor.uri, this.anchor.position, true);
                else this.status('请在代码中选择一个函数，再点击“当前符号”。');
                break;
            case 'expand': {
                const { generation, requestId, occurrenceId, symbolId, direction } = msg;
                if (generation !== this.generation || typeof requestId !== 'number' || typeof occurrenceId !== 'string' || typeof symbolId !== 'string' || (direction !== 'incoming' && direction !== 'outgoing')) return;
                try {
                    const relations = await this.provider.query(symbolId, direction);
                    if (generation !== this.generation) return;
                    for (const relation of relations) {
                        this.authorize({ uri: relation.symbol.uri, range: relation.symbol.range });
                        relation.sites.forEach(site => this.authorize(site));
                    }
                    this.post({ type: 'children', generation, requestId, occurrenceId, direction, relations });
                } catch (error) {
                    if (generation === this.generation) this.post({ type: 'queryError', generation, requestId, occurrenceId, direction, message: String(error) });
                }
                break;
            }
            case 'open':
                if (validLocation(msg.location) && this.allowed.has(JSON.stringify(msg.location))) {
                    this.suppressFollow = Date.now() + 1500;
                    clearTimeout(this.timer); ++this.resolution;
                    await openLocation(msg.location);
                }
                break;
            case 'follow':
                this.follow = msg.value === true;
                this.persist();
                clearTimeout(this.timer); ++this.resolution;
                this.post({ type: 'follow', value: this.follow });
                if (this.follow && this.lastEditor) {
                    const editor = this.lastEditor;
                    this.schedule(editor.document.uri, editor.selection.active);
                }
                break;
            case 'export': {
                if ((msg.format !== 'svg' && msg.format !== 'json') || typeof msg.content !== 'string' || msg.content.length > 20_000_000) return;
                const target = await vscode.window.showSaveDialog({ saveLabel: '导出当前调用关系', filters: msg.format === 'svg' ? { SVG: ['svg'] } : { JSON: ['json'] } });
                if (target) {
                    await vscode.workspace.fs.writeFile(target, Buffer.from(msg.content, 'utf8'));
                    this.status('调用关系已导出。');
                }
                break;
            }
            case 'current': {
                const editor = this.lastEditor;
                if (editor) await this.resolve(editor.document.uri, editor.selection.active, true);
                else this.status('请先激活一个代码编辑器。');
                break;
            }
            case 'refresh':
                this.provider.invalidate();
                if (this.root) await this.resolve(vscode.Uri.parse(this.root.uri), new vscode.Position(this.root.range.start.line, this.root.range.start.character), true, true);
                else if (this.anchor) await this.resolve(this.anchor.uri, this.anchor.position, true);
                break;
            case 'reroot': {
                if (msg.generation !== this.generation || typeof msg.symbolId !== 'string') return;
                // Re-resolve the definition to get a fresh provider-owned item.
                const symbol = msg.symbol as SymbolData;
                if (symbol?.id === msg.symbolId && validLocation(symbol) && this.allowed.has(JSON.stringify({ uri: symbol.uri, range: symbol.range }))) {
                    await this.resolve(vscode.Uri.parse(symbol.uri), new vscode.Position(symbol.range.start.line, symbol.range.start.character), true);
                }
                break;
            }
            case 'back': case 'forward': {
                const next = this.historyIndex + (msg.type === 'back' ? -1 : 1);
                if (next >= 0 && next < this.history.length) {
                    clearTimeout(this.timer); ++this.resolution;
                    this.historyIndex = next;
                    const symbol = this.history[next];
                    await this.resolve(vscode.Uri.parse(symbol.uri), new vscode.Position(symbol.range.start.line, symbol.range.start.character), true, true);
                }
                break;
            }
        }
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.timer);
        ++this.resolution;
        this.provider.dispose();
        this.disposables.forEach(d => d.dispose());
        this.panel.dispose();
    }
}
