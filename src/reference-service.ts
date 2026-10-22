import * as vscode from 'vscode';
import { CodeLocation, ReferenceGroup } from './protocol';
import { location, mapLimited, Report } from './symbols';

export async function queryReferences(uri: vscode.Uri, position: vscode.Position, report: Report = () => {}): Promise<vscode.Location[]> {
    const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', uri, position);
    const unique = new Map<string, vscode.Location>();
    for (const item of result || []) unique.set(JSON.stringify(location(item.uri, item.range)), item);
    report(`references uri=${uri} position=${position.line}:${position.character} count=${unique.size}`);
    return [...unique.values()];
}
export async function referenceGroups(locations: vscode.Location[]): Promise<{ groups: ReferenceGroup[]; notices: string[] }> {
    const files = new Map<string, vscode.Location[]>();
    for (const loc of locations) {
        const key = loc.uri.toString();
        if (!files.has(key)) files.set(key, []);
        files.get(key)!.push(loc);
    }
    const notices: string[] = [];
    const groups = await mapLimited([...files.values()], async items => {
        let doc: vscode.TextDocument | undefined;
        try { doc = await vscode.workspace.openTextDocument(items[0].uri); }
        catch (error) { notices.push(`${items[0].uri}: 无法读取代码预览，引用位置仍已保留。${String(error)}`); }
        return { path: vscode.workspace.asRelativePath(items[0].uri), items: items.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character).map(loc => {
            let text = '代码预览不可用';
            if (doc) {
                try { text = doc.lineAt(loc.range.start.line).text.trim(); }
                catch { notices.push(`${loc.uri}: 第 ${loc.range.start.line + 1} 行的预览已失效，请重新查询。`); }
            }
            return { ...location(loc.uri, loc.range), text };
        }) };
    });
    return { groups: groups.sort((a, b) => a.path.localeCompare(b.path)), notices };
}
export function plainLocation(value: CodeLocation): CodeLocation { return { uri: value.uri, range: value.range }; }
