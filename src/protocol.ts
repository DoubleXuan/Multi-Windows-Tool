export type Direction = 'incoming' | 'outgoing';
export type RelationMode = 'auto' | 'calls' | 'references' | 'contains';
export type RelationKind = 'calls' | 'references' | 'contains' | 'declaration';
export type RelationSource = 'callHierarchy' | 'references' | 'documentSymbols' | 'definitions';
export type SymbolCategory = 'function' | 'type' | 'field' | 'macro' | 'variable' | 'location' | 'unknown';
export interface Position { line: number; character: number }
export interface CodeRange { start: Position; end: Position }
export interface CodeLocation { uri: string; range: CodeRange }
export interface SymbolData extends CodeLocation {
    id: string; name: string; detail: string;
    kind?: number;
    category?: SymbolCategory;
    queryLocation?: CodeLocation;
    capabilities?: { calls: boolean; references: boolean; contains: boolean; dependencies?: boolean };
}
export interface RelationData {
    symbol: SymbolData;
    sourceId: string;
    targetId: string;
    kind: RelationKind;
    sources: RelationSource[];
    sites: CodeLocation[];
}
export interface QueryResult { relations: RelationData[]; notices: string[]; supported: boolean }
export interface ReferenceGroup { path: string; items: (CodeLocation & { text: string })[] }
export type HostMessage =
    | { type: 'root'; generation: number; symbol: SymbolData; follow: boolean; canBack: boolean; canForward: boolean; mode?: RelationMode }
    | { type: 'children'; generation: number; requestId: number; occurrenceId: string; direction: Direction; relations: RelationData[]; notices?: string[]; supported?: boolean }
    | { type: 'queryError'; generation: number; requestId: number; occurrenceId: string; direction: Direction; message: string }
    | { type: 'status'; message: string }
    | { type: 'follow'; value: boolean }
    | { type: 'invalidate'; generation: number }
    | { type: 'references'; title: string; groups: ReferenceGroup[]; notices?: string[] };
