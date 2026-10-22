import * as vscode from 'vscode';
import { location } from './provider';
import { ReferenceGroup } from './protocol';
import { createPanel, openLocation, validLocation } from './webview';

export async function findReferences(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showInformationMessage('请先在代码中选择符号。'); return; }
    const document = editor.document;
    const position = editor.selection.active;
    const range = document.getWordRangeAtPosition(position);
    const name = range ? document.getText(range) : '符号';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '正在查找引用…' }, async () => {
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', document.uri, position);
            if (!locations?.length) { void vscode.window.showInformationMessage(`未找到“${name}”的引用；请确认语言服务可用。`); return; }
            const grouped = new Map<string, vscode.Location[]>();
            for (const loc of locations) { const key = loc.uri.toString(); grouped.set(key, [...grouped.get(key) || [], loc]); }
            const groups: ReferenceGroup[] = await Promise.all([...grouped.values()].map(async group => {
                const doc = await vscode.workspace.openTextDocument(group[0].uri);
                return { path: vscode.workspace.asRelativePath(group[0].uri), items: group.sort((a, b) => a.range.start.compareTo(b.range.start)).map(loc => ({
                    ...location(loc.uri, loc.range), text: doc.lineAt(loc.range.start.line).text.trim()
                })) };
            }));
            groups.sort((a, b) => a.path.localeCompare(b.path));
            const allowed = new Set(groups.flatMap(group => group.items.map(item => JSON.stringify({ uri: item.uri, range: item.range }))));
            const panel = createPanel(context, `引用: ${name}`, undefined, 'multiRef.references');
            const listener = panel.webview.onDidReceiveMessage(async msg => {
                if (msg?.type === 'ready') await panel.webview.postMessage({ type: 'references', title: `引用: ${name}`, groups });
                if (msg?.type === 'open' && validLocation(msg.location) && allowed.has(JSON.stringify(msg.location))) {
                    try { await openLocation(msg.location); } catch (error) { void vscode.window.showErrorMessage(String(error)); }
                }
            });
            panel.onDidDispose(() => listener.dispose());
        } catch (error) { void vscode.window.showErrorMessage(`查找引用失败：${String(error)}`); }
    });
}
