import * as vscode from 'vscode';
import { AsyncCache } from './graph';
import { CodeLocation, Direction, QueryResult, RelationData, RelationKind, RelationMode, RelationSource, SymbolCategory, SymbolData } from './protocol';
import { category, contains, DocumentIndex, IndexedSymbol, location, mapLimited, mostSpecific, overlaps, Report } from './symbols';
import { queryReferences } from './reference-service';
import { MacroBody, scanMacro } from './cpp-macro';
export { location } from './symbols';

export function symbolKey(item: Pick<vscode.CallHierarchyItem, 'uri' | 'selectionRange' | 'kind' | 'name'>): string {
    return JSON.stringify([item.uri.toString(), item.selectionRange.start.line, item.selectionRange.start.character,
        item.selectionRange.end.line, item.selectionRange.end.character, item.kind, item.name]);
}
interface SymbolRecord {
    data: SymbolData;
    item?: vscode.CallHierarchyItem;
    indexed?: IndexedSymbol;
    attemptedCalls: boolean;
    macro?: MacroBody;
}
export class CallGraphProvider {
    private records = new Map<string, SymbolRecord>();
    private cache = new AsyncCache<QueryResult>();
    private revision = 0;
    private macros = new AsyncCache<MacroBody | undefined>();
    private index: DocumentIndex;
    constructor(private readonly report: Report = () => {}) { this.index = new DocumentIndex(report); }
    invalidate() { ++this.revision; this.cache.clear(); this.records.clear(); this.index.clear(); this.macros.clear(); }
    dispose() { this.invalidate(); }
    private check(revision: number) { if (revision !== this.revision) throw new Error('代码已变化，请刷新关系。'); }
    private data(name: string, kind: number, uri: vscode.Uri, range: vscode.Range, symbolCategory = category(kind), queryLocation = location(uri, range)): SymbolData {
        return { id: symbolKey({ name, kind, uri, selectionRange: range }), name, kind, category: symbolCategory,
            detail: vscode.workspace.asRelativePath(uri), ...location(uri, range), queryLocation,
            capabilities: { calls: symbolCategory === 'function', references: symbolCategory !== 'location', contains: symbolCategory === 'type' } };
    }
    register(item: vscode.CallHierarchyItem, queryLocation?: CodeLocation): SymbolData {
        const data = this.data(item.name, item.kind, item.uri, item.selectionRange, category(item.kind), queryLocation);
        data.queryLocation = queryLocation || this.records.get(data.id)?.data.queryLocation || data.queryLocation;
        data.capabilities!.calls = true;
        const existing = this.records.get(data.id);
        if (existing?.macro) { data.category = 'macro'; data.capabilities!.dependencies = true; }
        this.records.set(data.id, { ...existing, data, item, attemptedCalls: true });
        return data;
    }
    private registerIndexed(symbol: IndexedSymbol, queryLocation?: CodeLocation, symbolCategory?: SymbolCategory): SymbolData {
        const data = this.data(symbol.name, symbol.kind, symbol.uri, symbol.selectionRange, symbolCategory || category(symbol.kind), queryLocation);
        const existing = this.records.get(data.id);
        data.queryLocation = queryLocation || existing?.data.queryLocation || data.queryLocation;
        if (existing?.item) data.capabilities!.calls = true;
        if (existing?.macro && !symbolCategory) { data.category = 'macro'; data.capabilities!.dependencies = true; }
        this.records.set(data.id, { ...existing, data, indexed: symbol, attemptedCalls: existing?.attemptedCalls || false });
        return data;
    }
    private async optionalSymbols(uri: vscode.Uri, notices?: string[]): Promise<IndexedSymbol[]> {
        try { return await this.index.get(uri); }
        catch (error) {
            this.report(`documentSymbols failed uri=${uri} error=${String(error)}`);
            notices?.push(`${vscode.workspace.asRelativePath(uri)}: 无法获取所属符号，保留文件级引用。`);
            return [];
        }
    }
    async prepare(uri: vscode.Uri, position: vscode.Position): Promise<SymbolData[]> {
        const revision = this.revision;
        this.report(`prepare uri=${uri} position=${position.line}:${position.character}`);
        let items: vscode.CallHierarchyItem[] = [];
        try { items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>('vscode.prepareCallHierarchy', uri, position) || []; }
        catch (error) { this.report(`prepareCallHierarchy failed: ${String(error)}`); }
        this.check(revision);
        let document: vscode.TextDocument | undefined;
        let word = '', wordRange: vscode.Range | undefined;
        try {
            document = await vscode.workspace.openTextDocument(uri);
            wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) word = document.getText(wordRange);
            this.report(`document language=${document.languageId} version=${document.version} hierarchyRoots=${items.length}`);
        } catch (error) { this.report(`document seed unavailable: ${String(error)}`); }
        this.check(revision);
        // Some providers return the enclosing function when the cursor actually
        // selects a macro/field. Keep the selected symbol as the query target.
        const matching = word ? items.filter(item => {
            const base = item.name.split('(')[0].trim().split(/::|\./).pop();
            return base === word || (item.uri.toString() === uri.toString() && contains(item.selectionRange, position));
        }) : items;
        // Use the exact original caret for reference parity with VS Code.
        const queryLocation = location(uri, { start: position, end: position });
        if (matching.length) return matching.map(item => this.register(item, queryLocation));
        if (!word || !document || !wordRange) return [];
        let definitions: (vscode.Location | vscode.LocationLink)[] = [];
        try { definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>('vscode.executeDefinitionProvider', uri, position) || []; }
        catch (error) { this.report(`definitions failed: ${String(error)}`); }
        this.check(revision);
        const targets = definitions.length ? definitions.map(def => 'targetUri' in def
            ? { uri: def.targetUri, range: def.targetSelectionRange || def.targetRange }
            : { uri: def.uri, range: def.range }) : [{ uri, range: wordRange }];
        const resolved = await mapLimited(targets, target => this.resolveDefinition(target, word, revision, queryLocation));
        this.report(`resolved symbols=${resolved.length} categories=${resolved.map(item => item.category).join(',')}`);
        return [...new Map(resolved.map(symbol => [symbol.id, symbol])).values()];
    }
    private async resolveDefinition(target: { uri: vscode.Uri; range: vscode.Range }, name: string, revision: number, queryLocation?: CodeLocation): Promise<SymbolData> {
        const symbols = await this.optionalSymbols(target.uri);
        this.check(revision);
        let indexed = mostSpecific(symbols, target.range.start, true);
        if (!indexed) {
            const enclosing = mostSpecific(symbols, target.range.start);
            if (enclosing?.name === name) indexed = enclosing;
        }
        let macro: MacroBody | undefined;
        try {
            macro = await this.macros.get(JSON.stringify([target.uri.toString(), target.range.start.line]), async () => {
                const doc = await vscode.workspace.openTextDocument(target.uri);
                if (!/^\s*#\s*define\s+/.test(doc.lineAt(target.range.start.line).text)) return;
                return scanMacro(doc.getText(), target.range.start.line);
            });
            if (macro?.name !== name) macro = undefined;
        } catch (error) { this.report(`symbol classification unavailable: ${String(error)}`); }
        this.check(revision);
        if (!indexed && !macro) {
            try {
                const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>('vscode.prepareCallHierarchy', target.uri, new vscode.Position(target.range.start.line, target.range.start.character));
                this.check(revision);
                const item = items?.find(candidate => candidate.uri.toString() === target.uri.toString() && overlaps(candidate.selectionRange, target.range));
                if (item) return this.register(item, queryLocation);
            } catch (error) { this.check(revision); this.report(`definition call hierarchy unavailable: ${String(error)}`); }
        }
        const data = indexed ? this.registerIndexed(indexed, queryLocation, macro ? 'macro' : undefined)
            : this.data(name, 12, target.uri, target.range, macro ? 'macro' : 'unknown', queryLocation);
        const existing = this.records.get(data.id);
        if (macro) data.capabilities!.dependencies = true;
        this.records.set(data.id, { ...existing, data, macro, attemptedCalls: existing?.attemptedCalls || false });
        return data;
    }
    query(id: string, direction: Direction): Promise<RelationData[]> { return this.queryResult(id, direction, 'auto').then(result => result.relations); }
    queryResult(id: string, direction: Direction, mode: RelationMode): Promise<QueryResult> {
        const revision = this.revision;
        return this.cache.get(JSON.stringify([id, direction, mode]), async () => {
            this.check(revision);
            const record = this.records.get(id);
            if (!record) throw new Error('符号已失效，请刷新关系图。');
            const notices: string[] = [];
            if (record.data.category === 'location') return { relations: [], notices: ['此引用无法定位所属符号，可点击位置查看源码。'], supported: false };
            if (mode === 'auto' && direction === 'outgoing' && record.macro) return this.macroDependencies(record, revision);
            if (mode === 'contains' || (mode === 'auto' && direction === 'outgoing' && record.data.capabilities?.contains)) {
                if (direction !== 'outgoing') return { relations: [], notices: ['成员包含关系仅支持向外展开。'], supported: false };
                const symbols = await this.optionalSymbols(vscode.Uri.parse(record.data.uri), notices);
                this.check(revision);
                const indexed = record.indexed || mostSpecific(symbols, record.data.range.start, true);
                const relations = (indexed?.children || []).map(child => {
                    const symbol = this.registerIndexed(child);
                    return this.relation(record.data, symbol, 'contains', 'documentSymbols', [location(child.uri, child.selectionRange)]);
                });
                if (!indexed) notices.push('语言服务未返回此类型的成员信息。');
                return { relations: [...new Map(relations.map(relation => [relation.symbol.id, relation])).values()], notices, supported: !!indexed && !!record.data.capabilities?.contains };
            }
            const wantsCalls = mode === 'calls' || (mode === 'auto' && record.data.capabilities?.calls);
            let callError: unknown;
            let callRelations: RelationData[] = [];
            if (wantsCalls) {
                try { callRelations = await this.calls(record, direction, revision); }
                catch (error) { this.check(revision); callError = error; notices.push(`调用层级查询失败：${String(error)}。可使用引用模式查看位置。`); }
            }
            if (mode === 'calls') {
                if (callError) throw callError;
                return { relations: this.sort(callRelations), notices: record.item ? [] : ['语言服务未提供此符号的调用层级，请切换引用模式。'], supported: !!record.item };
            }
            if (direction === 'outgoing') return { relations: this.sort(callRelations), notices, supported: !!record.item && mode === 'auto' };
            let referenceRelations: RelationData[] = [];
            try { referenceRelations = await this.references(record, revision, notices); }
            catch (error) {
                this.check(revision);
                // A failed reference query must not look like a successful empty
                // result. Preserve calls when available, otherwise offer retry.
                if (!callRelations.length) throw error;
                notices.push(`引用查询失败，仅显示已获取的调用：${String(error)}`);
            }
            const relations = mode === 'references' ? referenceRelations : this.mergeCallsAndReferences(callRelations, referenceRelations);
            this.report(`relations id=${id} direction=${direction} mode=${mode} count=${relations.length} sites=${relations.reduce((sum, relation) => sum + relation.sites.length, 0)}`);
            return { relations: this.sort(relations), notices: [...new Set(notices)], supported: true };
        });
    }
    private relation(source: SymbolData, target: SymbolData, kind: RelationKind, origin: RelationSource, sites: CodeLocation[], display = target): RelationData {
        return { symbol: display, sourceId: source.id, targetId: target.id, kind, sources: [origin], sites: [...new Map(sites.map(site => [JSON.stringify(site), site])).values()] };
    }
    private sort(relations: RelationData[]) {
        for (const relation of relations) relation.sites = [...new Map(relation.sites.map(site => [JSON.stringify(site), site])).values()]
            .sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.range.end.line - b.range.end.line || a.range.end.character - b.range.end.character);
        return relations.sort((a, b) => a.symbol.name.localeCompare(b.symbol.name) || a.symbol.detail.localeCompare(b.symbol.detail) || a.kind.localeCompare(b.kind) || a.symbol.id.localeCompare(b.symbol.id));
    }
    private async macroDependencies(record: SymbolRecord, revision: number): Promise<QueryResult> {
        const macro = record.macro!;
        const notices = ['宏体引用由语言服务的定义查询解析；不代表预处理展开后已确认的调用。'];
        if (macro.truncated) notices.push('宏体较大，本次仅解析前 200 个候选标识符。');
        const relations = await mapLimited(macro.identifiers, async token => {
            let definitions: (vscode.Location | vscode.LocationLink)[] = [];
            try {
                definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>('vscode.executeDefinitionProvider', vscode.Uri.parse(record.data.uri), new vscode.Position(token.range.start.line, token.range.start.character)) || [];
            } catch (error) { notices.push(`宏体标识符 ${token.name} 解析失败：${String(error)}`); }
            this.check(revision);
            return mapLimited(definitions, async definition => {
                const target = 'targetUri' in definition ? { uri: definition.targetUri, range: definition.targetSelectionRange || definition.targetRange } : definition;
                const symbol = await this.resolveDefinition(target, token.name, revision);
                this.check(revision);
                return this.relation(record.data, symbol, 'references', 'definitions', [{ uri: record.data.uri, range: token.range }]);
            });
        });
        const grouped = new Map<string, RelationData>();
        for (const relation of relations.flat()) {
            const key = JSON.stringify([relation.sourceId, relation.targetId]);
            const existing = grouped.get(key);
            if (existing) existing.sites.push(...relation.sites); else grouped.set(key, relation);
        }
        if (macro.identifiers.length && !grouped.size) notices.push('语言服务未能解析宏体中的符号；可继续查看宏的使用引用。');
        this.report(`macroDependencies name=${macro.name} candidates=${macro.identifiers.length} resolved=${grouped.size}`);
        return { relations: this.sort([...grouped.values()]), notices: [...new Set(notices)], supported: true };
    }
    private async calls(record: SymbolRecord, direction: Direction, revision: number): Promise<RelationData[]> {
        if (!record.item && !record.attemptedCalls) {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>('vscode.prepareCallHierarchy', vscode.Uri.parse(record.data.uri), new vscode.Position(record.data.range.start.line, record.data.range.start.character));
            this.check(revision);
            // Never attach the enclosing function's calls to a field/macro node.
            record.item = items?.find(item => item.uri.toString() === record.data.uri && overlaps(item.selectionRange, record.data.range));
            record.attemptedCalls = true;
        }
        if (!record.item) return [];
        const grouped = new Map<string, RelationData>();
        const add = (item: vscode.CallHierarchyItem, ranges: vscode.Range[], uri: vscode.Uri) => {
            const symbol = this.register(item);
            const relation = direction === 'incoming'
                ? this.relation(symbol, record.data, 'calls', 'callHierarchy', ranges.map(range => location(uri, range)), symbol)
                : this.relation(record.data, symbol, 'calls', 'callHierarchy', ranges.map(range => location(uri, range)));
            const existing = grouped.get(symbol.id);
            if (existing) existing.sites = [...new Map([...existing.sites, ...relation.sites].map(site => [JSON.stringify(site), site])).values()];
            else grouped.set(symbol.id, relation);
        };
        if (direction === 'incoming') {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>('vscode.provideIncomingCalls', record.item);
            this.check(revision);
            for (const call of calls || []) add(call.from, call.fromRanges, call.from.uri);
        } else {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>('vscode.provideOutgoingCalls', record.item);
            this.check(revision);
            for (const call of calls || []) add(call.to, call.fromRanges, record.item.uri);
        }
        return [...grouped.values()];
    }
    private async references(record: SymbolRecord, revision: number, notices: string[]): Promise<RelationData[]> {
        const anchor = record.data.queryLocation || record.data;
        const refs = await queryReferences(vscode.Uri.parse(anchor.uri), new vscode.Position(anchor.range.start.line, anchor.range.start.character), this.report);
        this.check(revision);
        const files = new Map<string, vscode.Location[]>();
        for (const ref of refs) {
            const key = ref.uri.toString();
            if (!files.has(key)) files.set(key, []);
            files.get(key)!.push(ref);
        }
        const groups = await mapLimited([...files.values()], async locations => {
            const uri = locations[0].uri;
            const symbols = await this.optionalSymbols(uri, notices);
            this.check(revision);
            const results: RelationData[] = [];
            for (const ref of locations) {
                const declaration = record.data.uri === uri.toString() && overlaps(record.data.range, ref.range);
                const owner = mostSpecific(symbols.filter(symbol => category(symbol.kind) === 'function'), ref.range.start) || mostSpecific(symbols, ref.range.start);
                let symbol: SymbolData;
                if (declaration) symbol = record.data;
                else if (owner) symbol = this.registerIndexed(owner);
                else {
                    // A missing document-symbol provider must not drop references.
                    symbol = { id: `file:${uri}`, name: uri.fsPath.split(/[\\/]/).pop() || uri.toString(), detail: vscode.workspace.asRelativePath(uri),
                        category: 'location', ...location(uri, ref.range), capabilities: { calls: false, references: false, contains: false } };
                    this.records.set(symbol.id, { data: symbol, attemptedCalls: true });
                }
                results.push(this.relation(symbol, record.data, declaration ? 'declaration' : 'references', 'references', [location(uri, ref.range)], symbol));
            }
            return results;
        });
        this.check(revision);
        const grouped = new Map<string, RelationData>();
        for (const relation of groups.flat()) {
            const key = JSON.stringify([relation.sourceId, relation.targetId, relation.kind]);
            const existing = grouped.get(key);
            if (existing) existing.sites.push(...relation.sites); else grouped.set(key, relation);
        }
        return [...grouped.values()];
    }
    private mergeCallsAndReferences(calls: RelationData[], references: RelationData[]): RelationData[] {
        const remaining: RelationData[] = [];
        const matchedSites = new Map<RelationData, CodeLocation[]>();
        for (const reference of references) {
            const sites = reference.sites.filter(site => {
                const match = calls.find(call => call.sites.some(callSite => callSite.uri === site.uri && overlaps(callSite.range, site.range)));
                if (!match) return true;
                if (!match.sources.includes('references')) match.sources.push('references');
                if (!matchedSites.has(match)) matchedSites.set(match, []);
                matchedSites.get(match)!.push(site);
                return false;
            });
            if (sites.length) remaining.push({ ...reference, sites });
        }
        // Preserve every distinct native reference, including overlapping ranges
        // returned by multiple providers, while replacing broad call ranges.
        for (const [call, sites] of matchedSites) call.sites = [
            ...call.sites.filter(callSite => !sites.some(site => callSite.uri === site.uri && overlaps(callSite.range, site.range))), ...sites
        ];
        return [...calls, ...remaining];
    }
}
