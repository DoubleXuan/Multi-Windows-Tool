import { Direction, RelationMode, SymbolData } from './protocol';

export function directions(symbol: SymbolData, mode: RelationMode): Direction[] {
    const caps = symbol.capabilities;
    if (symbol.category === 'location') return [];
    if (mode === 'references') return caps?.references === false ? [] : ['incoming'];
    if (mode === 'contains') return caps?.contains ? ['outgoing'] : [];
    if (mode === 'calls') return ['incoming', 'outgoing'];
    if (!caps) return ['incoming', 'outgoing'];
    return [...(caps.references ? ['incoming' as const] : []), ...(caps.calls || caps.contains || caps.dependencies ? ['outgoing' as const] : [])];
}
export function branchLabel(symbol: SymbolData, direction: Direction, mode: RelationMode): string {
    if (mode === 'references') return '引用者';
    if (mode === 'contains' || (mode === 'auto' && direction === 'outgoing' && symbol.capabilities?.contains)) return '成员';
    if (mode === 'auto' && direction === 'outgoing' && symbol.category === 'macro') return '宏体引用';
    if (mode === 'auto' && direction === 'incoming' && symbol.capabilities) return symbol.capabilities.calls ? '调用/引用者' : '引用者';
    return direction === 'incoming' ? '调用者' : '被调用者';
}
