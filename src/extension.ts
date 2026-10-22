import * as vscode from 'vscode';
import { RelationshipViewer } from './controller';
import { findReferences } from './references';

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Multi-Windows-Tool');
    const report = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
    let lastEditor = vscode.window.activeTextEditor;
    context.subscriptions.push(output, vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) lastEditor = editor; }));
    const open = () => {
        const editor = vscode.window.activeTextEditor || lastEditor;
        context.subscriptions.push(new RelationshipViewer(context, editor, undefined, undefined, report));
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('multiRef.find', () => findReferences(context, vscode.window.activeTextEditor || lastEditor, report)),
        vscode.commands.registerCommand('multiRef.callHierarchy', open),
        vscode.commands.registerCommand('multiRef.open', open),
        vscode.commands.registerCommand('multiRef.restore', () => context.subscriptions.push(new RelationshipViewer(context, undefined, undefined, undefined, report))),
        vscode.commands.registerCommand('multiRef.diagnostics', () => output.show(true)),
        vscode.window.registerWebviewPanelSerializer('multiRef.relations', {
            async deserializeWebviewPanel(panel, state: unknown) {
                context.subscriptions.push(new RelationshipViewer(context, undefined, panel, state, report));
            }
        })
    );
}
export function deactivate() {}
