import { Direction, RelationData, SymbolData } from './protocol';

export interface Branch {
    state: 'idle' | 'loading' | 'loaded' | 'error';
    expanded: boolean;
    requestId?: number;
    error?: string;
    children: string[];
    visibleCount: number;
}
export interface Occurrence {
    id: string;
    symbol: SymbolData;
    parent?: string;
    direction?: Direction;
    relation?: RelationData;
    recursive: boolean;
    incoming: Branch;
    outgoing: Branch;
}
const branch = (): Branch => ({ state: 'idle', expanded: false, children: [], visibleCount: 20 });

// Semantic symbols may appear on several paths. Visibility belongs to a path,
// while queries are cached by semantic identity in the extension host.
export class GraphModel {
    readonly occurrences = new Map<string, Occurrence>();
    private sequence = 0;
    constructor(root: SymbolData) {
        this.occurrences.set('root', { id: 'root', symbol: root, recursive: false, incoming: branch(), outgoing: branch() });
    }
    begin(id: string, direction: Direction): number | undefined {
        const node = this.occurrences.get(id);
        if (!node || node.recursive) return;
        const state = node[direction];
        if (state.state === 'loading') return;
        state.expanded = true;
        if (state.state === 'loaded') return;
        state.state = 'loading';
        state.error = undefined;
        return state.requestId = ++this.sequence;
    }
    collapse(id: string, direction: Direction) {
        const state = this.occurrences.get(id)?.[direction];
        if (state) state.expanded = false;
    }
    showMore(id: string, direction: Direction) {
        const state = this.occurrences.get(id)?.[direction];
        if (state) state.visibleCount += 20;
    }
    accept(id: string, direction: Direction, requestId: number, relations: RelationData[]): boolean {
        const node = this.occurrences.get(id);
        if (!node || node[direction].requestId !== requestId || node[direction].state !== 'loading') return false;
        const state = node[direction];
        const ancestors = new Set<string>();
        let ancestor: Occurrence | undefined = node;
        while (ancestor) { ancestors.add(ancestor.symbol.id); ancestor = ancestor.parent ? this.occurrences.get(ancestor.parent) : undefined; }
        state.children = relations.map((relation, index) => {
            const childId = `${id}/${direction}/${index}`;
            this.occurrences.set(childId, {
                id: childId, symbol: relation.symbol, parent: id, direction, relation,
                recursive: ancestors.has(relation.symbol.id), incoming: branch(), outgoing: branch()
            });
            return childId;
        });
        state.state = 'loaded';
        return true;
    }
    fail(id: string, direction: Direction, requestId: number, error: string) {
        const state = this.occurrences.get(id)?.[direction];
        if (!state || state.requestId !== requestId || state.state !== 'loading') return false;
        state.state = 'error'; state.error = error;
        return true;
    }
    visible(): Occurrence[] {
        const result: Occurrence[] = [];
        const visit = (id: string) => {
            const node = this.occurrences.get(id);
            if (!node) return;
            result.push(node);
            for (const direction of ['incoming', 'outgoing'] as Direction[]) {
                if (node[direction].expanded) node[direction].children.slice(0, node[direction].visibleCount).forEach(visit);
            }
        };
        visit('root');
        return result;
    }
}

export class AsyncCache<T> {
    private entries = new Map<string, Promise<T>>();
    get(key: string, query: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(key);
        if (existing) return existing;
        const pending = Promise.resolve().then(query).catch(error => {
            if (this.entries.get(key) === pending) this.entries.delete(key);
            throw error;
        });
        this.entries.set(key, pending);
        return pending;
    }
    clear() { this.entries.clear(); }
}
