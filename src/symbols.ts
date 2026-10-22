import * as vscode from 'vscode';
import { AsyncCache } from './graph';
import { CodeLocation, CodeRange, Position, SymbolCategory } from './protocol';

export type Report = (message: string) => void;
export interface IndexedSymbol {
    name: string; kind: number; uri: vscode.Uri; range: vscode.Range; selectionRange: vscode.Range;
    children: IndexedSymbol[];
}
export function location(uri: vscode.Uri, range: CodeRange): CodeLocation {
    return { uri: uri.toString(), range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } } };
}
export function compare(a: Position, b: Position) { return a.line - b.line || a.character - b.character; }
export function contains(range: CodeRange, position: Position) { return compare(range.start, position) <= 0 && compare(position, range.end) < 0; }
export function overlaps(a: CodeRange, b: CodeRange) { return compare(a.start, b.end) < 0 && compare(b.start, a.end) < 0; }
export function category(kind: number): SymbolCategory {
    if ([5, 8, 11].includes(kind)) return 'function';
    if ([4, 9, 10, 22, 2].includes(kind)) return 'type';
    if ([6, 7, 21].includes(kind)) return 'field';
    if ([12, 13, 18].includes(kind)) return 'variable';
    return 'unknown';
}
export function mostSpecific(symbols: IndexedSymbol[], position: Position, selectionOnly = false): IndexedSymbol | undefined {
    const matches = symbols.filter(symbol => contains(selectionOnly ? symbol.selectionRange : symbol.range, position));
    return matches.sort((a, b) => compare(b.range.start, a.range.start) || compare(a.range.end, b.range.end))[0];
}
export class DocumentIndex {
    private cache = new AsyncCache<IndexedSymbol[]>();
    constructor(private readonly report: Report) {}
    clear() { this.cache.clear(); }
    get(uri: vscode.Uri): Promise<IndexedSymbol[]> {
        return this.cache.get(uri.toString(), async () => {
            const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', uri);
            const all: IndexedSymbol[] = [];
            const flat = new Set<IndexedSymbol>();
            const visit = (entry: vscode.DocumentSymbol | vscode.SymbolInformation): IndexedSymbol => {
                if ('selectionRange' in entry) {
                    const node: IndexedSymbol = { name: entry.name, kind: entry.kind, uri, range: entry.range, selectionRange: entry.selectionRange, children: [] };
                    all.push(node); node.children = (entry.children || []).map(visit); return node;
                }
                const node: IndexedSymbol = { name: entry.name, kind: entry.kind, uri: entry.location.uri, range: entry.location.range, selectionRange: entry.location.range, children: [] };
                all.push(node); flat.add(node); return node;
            };
            (result || []).forEach(visit);
            // Flat providers may expose full enclosing ranges. Do not guess owners
            // from containerName alone, which is ambiguous for same-name types.
            if (flat.size) {
                const ordered = [...all].sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()) || compare(a.range.start, b.range.start) || compare(b.range.end, a.range.end));
                const stack: IndexedSymbol[] = [];
                for (const node of ordered) {
                    while (stack.length) {
                        const parent = stack[stack.length - 1];
                        if (parent.uri.toString() === node.uri.toString() && contains(parent.range, node.range.start) && compare(parent.range.end, node.range.end) >= 0
                            && (compare(parent.range.start, node.range.start) !== 0 || compare(parent.range.end, node.range.end) !== 0)) break;
                        stack.pop();
                    }
                    const parent = stack[stack.length - 1];
                    if (parent && flat.has(node) && !parent.children.includes(node)) parent.children.push(node);
                    stack.push(node);
                }
            }
            this.report(`documentSymbols uri=${uri} count=${all.length}`);
            return all;
        });
    }
}

export async function mapLimited<T, R>(values: T[], work: (value: T) => Promise<R>, concurrency = 4): Promise<R[]> {
    const output: R[] = new Array(values.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (index < values.length) { const current = index++; output[current] = await work(values[current]); }
    }));
    return output;
}
