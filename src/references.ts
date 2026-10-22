import * as vscode from 'vscode';
import { createPanel, openLocation, validLocation } from './webview';
import { plainLocation, queryReferences, referenceGroups } from './reference-service';
import { Report } from './symbols';

export async function findReferences(context: vscode.ExtensionContext, editor = vscode.window.activeTextEditor, report: Report = () => {}) {
    if (!editor) { void vscode.window.showInformationMessage('请先在代码中选择符号。'); return; }
    const document = editor.document;
    const position = editor.selection.active;
    const range = document.getWordRangeAtPosition(position);
    const name = range ? document.getText(range) : '符号';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '正在查找引用…' }, async () => {
        try {
            report(`findReferences language=${document.languageId} version=${document.version}`);
            const locations = await queryReferences(document.uri, position, report);
            if (!locations.length) { void vscode.window.showInformationMessage(`语言服务未返回“${name}”的引用。`); return; }
            const { groups, notices } = await referenceGroups(locations);
            notices.forEach(report);
            const allowed = new Set(groups.flatMap(group => group.items.map(item => JSON.stringify(plainLocation(item)))));
            const panel = createPanel(context, `引用: ${name}`, undefined, 'multiRef.references');
            const listener = panel.webview.onDidReceiveMessage(async msg => {
                if (msg?.type === 'ready') await panel.webview.postMessage({ type: 'references', title: `引用: ${name}`, groups, notices });
                if (msg?.type === 'open' && validLocation(msg.location) && allowed.has(JSON.stringify(msg.location))) {
                    try { await openLocation(msg.location); } catch (error) { void vscode.window.showErrorMessage(String(error)); }
                }
            });
            panel.onDidDispose(() => listener.dispose());
        } catch (error) { report(`findReferences failed: ${String(error)}`); void vscode.window.showErrorMessage(`查找引用失败：${String(error)}`); }
    });
}
