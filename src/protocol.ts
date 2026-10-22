export type Direction = 'incoming' | 'outgoing';
export interface Position { line: number; character: number }
export interface CodeRange { start: Position; end: Position }
export interface CodeLocation { uri: string; range: CodeRange }
export interface SymbolData extends CodeLocation { id: string; name: string; detail: string }
export interface RelationData {
    symbol: SymbolData;
    callerId: string;
    calleeId: string;
    sites: CodeLocation[];
}
export interface ReferenceGroup { path: string; items: (CodeLocation & { text: string })[] }
export type HostMessage =
    | { type: 'root'; generation: number; symbol: SymbolData; follow: boolean; canBack: boolean; canForward: boolean }
    | { type: 'children'; generation: number; requestId: number; occurrenceId: string; direction: Direction; relations: RelationData[] }
    | { type: 'queryError'; generation: number; requestId: number; occurrenceId: string; direction: Direction; message: string }
    | { type: 'status'; message: string }
    | { type: 'follow'; value: boolean }
    | { type: 'invalidate'; generation: number }
    | { type: 'references'; title: string; groups: ReferenceGroup[] };
