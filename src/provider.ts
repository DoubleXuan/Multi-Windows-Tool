import * as vscode from 'vscode';
import { AsyncCache } from './graph';
import { CodeLocation, Direction, RelationData, SymbolData } from './protocol';

export function symbolKey(item: vscode.CallHierarchyItem): string {
    return JSON.stringify([item.uri.toString(), item.selectionRange.start.line, item.selectionRange.start.character,
        item.selectionRange.end.line, item.selectionRange.end.character, item.kind, item.name]);
}
export function location(uri: vscode.Uri, range: vscode.Range): CodeLocation {
    return { uri: uri.toString(), range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } } };
}
export class CallGraphProvider {
    private items = new Map<string, vscode.CallHierarchyItem>();
    private cache = new AsyncCache<RelationData[]>();
    private revision = 0;
    invalidate() { ++this.revision; this.cache.clear(); this.items.clear(); }
    dispose() { this.invalidate(); }
    register(item: vscode.CallHierarchyItem): SymbolData {
        const id = symbolKey(item);
        // Retain the original language-provider item, including provider metadata.
        this.items.set(id, item);
        return { id, name: item.name, detail: vscode.workspace.asRelativePath(item.uri), ...location(item.uri, item.selectionRange) };
    }
    async prepare(uri: vscode.Uri, position: vscode.Position): Promise<SymbolData[]> {
        const revision = this.revision;
        const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>('vscode.prepareCallHierarchy', uri, position);
        if (revision !== this.revision) return [];
        return (items || []).map(item => this.register(item));
    }
    query(id: string, direction: Direction): Promise<RelationData[]> {
        const revision = this.revision;
        return this.cache.get(JSON.stringify([id, direction]), async () => {
            const item = this.items.get(id);
            if (!item) throw new Error('符号已失效，请刷新关系图。');
            const grouped = new Map<string, RelationData>();
            const add = (target: vscode.CallHierarchyItem, ranges: vscode.Range[], callerUri: vscode.Uri) => {
                const symbol = this.register(target);
                let relation = grouped.get(symbol.id);
                if (!relation) {
                    relation = { symbol, callerId: direction === 'incoming' ? symbol.id : id,
                        calleeId: direction === 'incoming' ? id : symbol.id, sites: [] };
                    grouped.set(symbol.id, relation);
                }
                for (const range of ranges) {
                    const site = location(callerUri, range);
                    if (!relation.sites.some(s => JSON.stringify(s) === JSON.stringify(site))) relation.sites.push(site);
                }
            };
            if (direction === 'incoming') {
                const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>('vscode.provideIncomingCalls', item);
                if (revision !== this.revision) throw new Error('代码已变化，请刷新调用关系。');
                for (const call of calls || []) add(call.from, call.fromRanges, call.from.uri);
            } else {
                const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>('vscode.provideOutgoingCalls', item);
                if (revision !== this.revision) throw new Error('代码已变化，请刷新调用关系。');
                // Outgoing fromRanges are positions in the caller, not the callee.
                for (const call of calls || []) add(call.to, call.fromRanges, item.uri);
            }
            return [...grouped.values()].sort((a, b) => a.symbol.name.localeCompare(b.symbol.name) || a.symbol.detail.localeCompare(b.symbol.detail) || a.symbol.id.localeCompare(b.symbol.id));
        });
    }
}
