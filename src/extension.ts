import * as vscode from 'vscode';
import { RelationshipViewer } from './controller';
import { findReferences } from './references';

export function activate(context: vscode.ExtensionContext) {
    const open = () => {
        const editor = vscode.window.activeTextEditor;
        context.subscriptions.push(new RelationshipViewer(context, editor));
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('multiRef.find', () => findReferences(context)),
        vscode.commands.registerCommand('multiRef.callHierarchy', open),
        vscode.commands.registerCommand('multiRef.open', open),
        vscode.commands.registerCommand('multiRef.restore', () => context.subscriptions.push(new RelationshipViewer(context))),
        vscode.window.registerWebviewPanelSerializer('multiRef.relations', {
            async deserializeWebviewPanel(panel, state: unknown) {
                context.subscriptions.push(new RelationshipViewer(context, undefined, panel, state));
            }
        })
    );
}
export function deactivate() {}
