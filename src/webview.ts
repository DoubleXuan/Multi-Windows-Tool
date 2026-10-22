import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { CodeLocation } from './protocol';

export function createPanel(context: vscode.ExtensionContext, title: string, existing?: vscode.WebviewPanel, kind = 'multiRef.relations'): vscode.WebviewPanel {
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')];
    const panel = existing || vscode.window.createWebviewPanel(kind, title, vscode.ViewColumn.Beside, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: roots
    });
    if (existing) panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', file));
    const nonce = randomBytes(18).toString('hex');
    panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src 'none';">
<link rel="stylesheet" href="${asset('app.css')}"><title>调用关系</title></head>
<body><main id="app"></main><script nonce="${nonce}" src="${asset('elk.bundled.js')}"></script><script nonce="${nonce}" src="${asset('app.js')}"></script></body></html>`;
    return panel;
}
export function validLocation(value: unknown): value is CodeLocation {
    if (!value || typeof value !== 'object') return false;
    const v = value as CodeLocation;
    const validPosition = (p: { line: number; character: number } | undefined) => !!p && Number.isSafeInteger(p.line) && p.line >= 0 && Number.isSafeInteger(p.character) && p.character >= 0;
    return typeof v.uri === 'string' && validPosition(v.range?.start) && validPosition(v.range?.end);
}
export async function openLocation(target: CodeLocation) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    const range = doc.validateRange(new vscode.Range(target.range.start.line, target.range.start.character, target.range.end.line, target.range.end.character));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
