import * as vscode from 'vscode';
import * as path from 'path';

// =============================================================
//  主入口：注册所有命令
// =============================================================
export function activate(context: vscode.ExtensionContext) {
    // 1. 注册 Find References
    context.subscriptions.push(vscode.commands.registerCommand('multiRef.find', async () => {
        await handleFindReferences(context);
    }));

    // 2. 注册 Call Hierarchy
    context.subscriptions.push(vscode.commands.registerCommand('multiRef.callHierarchy', async () => {
        await handleCallHierarchy(context);
    }));
}

export function deactivate() {}

// =============================================================
//  通用工具：生成 HTML 外壳 (含 CSS 优化)
// =============================================================
function getHtmlShell(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, bodyContent: string, specificScript: string) {
    // 获取本地资源路径
    const stylePath = vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css');
    const styleUri = webview.asWebviewUri(stylePath);

    // 配置 CSP 允许加载本地样式和字体
    const csp = `
        default-src 'none'; 
        style-src ${webview.cspSource} 'unsafe-inline'; 
        script-src 'unsafe-inline'; 
        font-src ${webview.cspSource};
    `;

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <link href="${styleUri}" rel="stylesheet" />
        <style>
            body { padding:10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow-x: hidden; }
            
            /* =========================================
               布局与截断优化 (No Wrap)
            ========================================= */
            .tree-node, .file-group { margin-left: 10px; }
            
            /* Flex 布局，不允许换行 */
            .node-content, .file-header { 
                display: flex; align-items: center; 
                cursor: pointer; padding: 4px; border-radius: 3px; 
                white-space: nowrap; 
                overflow: hidden;    
            }
            .node-content:hover, .file-header:hover { background: var(--vscode-list-hoverBackground); }
            
            /* 文本区域容器，占据剩余空间 */
            .text-group { 
                flex: 1; 
                display: flex; align-items: baseline; 
                min-width: 0; /* 关键：允许 flex 子项缩小以触发截断 */
                overflow: hidden;
            }

            /* 具体的文本元素 */
            .name { font-weight: bold; margin-right: 6px; white-space: nowrap; }
            .detail { 
                color: var(--vscode-descriptionForeground); font-size: 0.9em; opacity: 0.8; 
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
            }

            /* Reference 列表项 */
            .ref-item { 
                display: flex; align-items: center; 
                padding: 3px 24px; cursor: pointer; 
                white-space: nowrap; overflow: hidden; 
            }
            .ref-item:hover { background: var(--vscode-list-hoverBackground); }
            
            .line-num { 
                color: var(--vscode-descriptionForeground); 
                margin-right: 10px; min-width: 40px; text-align: right; 
                flex-shrink: 0; 
            }
            
            .code-text { 
                flex: 1; min-width: 0; 
                font-family: var(--vscode-editor-font-family); 
                opacity: 0.9; 
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
            }

            /* =========================================
               图标颜色与样式
            ========================================= */
            .icon-box { width: 16px; height: 16px; display: flex; justify-content: center; align-items: center; margin-right: 4px; flex-shrink: 0; }
            .codicon { font-size: 14px; }

            /* Call Hierarchy 函数图标 (紫色) */
            .codicon-symbol-method { color: var(--vscode-symbolIcon-functionForeground); }

            /* Reference: C/C++ 源文件 (蓝色/关键字色) */
            .codicon-file-code { color: var(--vscode-symbolIcon-keywordForeground); }

            /* Reference: 头文件 (青色/接口色) */
            .codicon-file-text { color: var(--vscode-symbolIcon-interfaceForeground); }

            /* Reference: 普通文件 (半透明) */
            .codicon-file { opacity: 0.7; }
            
            /* 旋转箭头 */
            .toggle-icon { transition: transform 0.2s; opacity: 0.8; }
            .toggle-icon:hover { color: var(--vscode-textLink-activeForeground); opacity: 1; }
            .expanded > .node-content .toggle-icon, 
            .expanded > .file-header .toggle-icon { transform: rotate(90deg); }
            
            /* 子节点容器 */
            .children { display: none; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); margin-left: 8px; }
            .expanded > .children { display: block; }
            
            .loading { padding-left: 20px; color: gray; font-style: italic; }
        </style>
    </head>
    <body>
        ${title ? `<h3 style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${title}">${title}</h3>` : ''}
        <div id="root">${bodyContent}</div>
        <script>
            const vscode = acquireVsCodeApi();
            ${specificScript}
        </script>
    </body>
    </html>`;
}

// =============================================================
//  功能 A: Find References (引用查找)
// =============================================================

async function handleFindReferences(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const position = editor.selection.active;
    const word = document.getText(document.getWordRangeAtPosition(position)) || 'Symbol';

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "正在查找引用..." }, async () => {
        try {
            const locations: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, position);
            
            if (!locations || locations.length === 0) {
                vscode.window.showInformationMessage(`未找到 '${word}' 的引用`);
                return;
            }

            const panel = vscode.window.createWebviewPanel('multiRefWindow', `Ref: ${word}`, vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            });

            const fileGroups = await processRefLocations(locations);

            const listHtml = fileGroups.map(file => `
                <div class="file-group expanded">
                    <!-- title: 悬停显示完整文件路径 -->
                    <div class="file-header" title="${escapeHtml(file.filePath)}" onclick="this.parentElement.classList.toggle('expanded')">
                        <div class="icon-box"><span class="codicon codicon-chevron-right toggle-icon"></span></div>
                        <!-- iconClass: 动态颜色图标 -->
                        <div class="icon-box"><span class="codicon ${file.iconClass}"></span></div>
                        
                        <div class="text-group">
                            <span class="name">${escapeHtml(file.filePath)}</span>
                            <span class="detail">(${file.items.length})</span>
                        </div>
                    </div>
                    <div class="children" style="display:block">
                        ${file.items.map((r: any) => `
                            <!-- title: 悬停显示完整代码行 -->
                            <div class="ref-item" title="${escapeHtml(r.text)}" onclick="openLoc('${r.uri}', ${r.range.start.line}, ${r.range.start.character}, ${r.range.end.line}, ${r.range.end.character})">
                                <span class="line-num">${r.line + 1}:</span>
                                <span class="code-text">${escapeHtml(r.text)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('');

            const script = `
                function openLoc(uri, sLine, sChar, eLine, eChar) {
                    vscode.postMessage({command: 'open', uri, sLine, sChar, eLine, eChar});
                }
            `;

            panel.webview.html = getHtmlShell(panel.webview, context.extensionUri, `References: ${word} (${locations.length})`, listHtml, script);

            panel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'open') openDocument(msg.uri, msg.sLine, msg.sChar, msg.eLine, msg.eChar);
            });

        } catch (e) {
            vscode.window.showErrorMessage("查找引用失败: " + e);
        }
    });
}

// 辅助：处理引用数据 + 分配文件图标
async function processRefLocations(locations: vscode.Location[]) {
    const groups = new Map<string, any>();
    for (const loc of locations) {
        const k = loc.uri.toString();
        if (!groups.has(k)) groups.set(k, { uri: loc.uri, items: [] });
        groups.get(k).items.push(loc);
    }
    
    const res = [];
    for (const g of groups.values()) {
        const doc = await vscode.workspace.openTextDocument(g.uri);
        const filePath = vscode.workspace.asRelativePath(g.uri);
        
        // 依据后缀名分配图标
        const ext = path.extname(g.uri.fsPath).toLowerCase();
        let iconClass = 'codicon-file'; 

        if (['.c', '.cpp', '.cxx', '.cc', '.m', '.mm'].includes(ext)) {
            // 源文件: file-code (蓝/紫)
            iconClass = 'codicon-file-code';
        } else if (['.h', '.hpp', '.hxx'].includes(ext)) {
            // 头文件: file-text (青/绿)
            iconClass = 'codicon-file-text';
        }

        res.push({
            filePath: filePath,
            iconClass: iconClass,
            items: g.items.map((loc: vscode.Location) => ({
                line: loc.range.start.line,
                text: doc.lineAt(loc.range.start.line).text.trim(),
                uri: loc.uri.toString(),
                range: loc.range
            }))
        });
    }
    return res;
}

// =============================================================
//  功能 B: Call Hierarchy (调用层级)
// =============================================================

class HierarchySession {
    private idMap = new Map<string, vscode.CallHierarchyItem>();
    registerItem(item: vscode.CallHierarchyItem) { 
        const id = 'id_' + Math.random().toString(36).substr(2, 9); 
        this.idMap.set(id, item); 
        return id; 
    }
    getItem(id: string) { return this.idMap.get(id); }
    dispose() { this.idMap.clear(); }
}

async function handleCallHierarchy(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "正在分析调用层级..." }, async () => {
        try {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', editor.document.uri, editor.selection.active);
            if (!items || (Array.isArray(items) && items.length === 0)) {
                vscode.window.showInformationMessage('此处没有调用层级信息');
                return;
            }

            const rootItem = Array.isArray(items) ? items[0] : items;
            const session = new HierarchySession();
            const rootId = session.registerItem(rootItem);

            const panel = vscode.window.createWebviewPanel('callHierarchyWindow', `Calls: ${rootItem.name}`, vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            });

            const script = `
                window.addEventListener('message', e => {
                    const m = e.data;
                    if(m.command === 'setRoot') renderNode(document.getElementById('root'), m.node);
                    if(m.command === 'appendChildren') finishLoad(m.parentId, m.children);
                });

                function renderNode(container, node) {
                    const el = document.createElement('div');
                    el.className = 'tree-node';
                    el.id = 'n-' + node.id;
                    
                    const tooltip = escape(node.name) + ' (' + escape(node.detail) + ')';

                    el.innerHTML = \`
                        <!-- title: 悬停显示完整函数名和路径 -->
                        <div class="node-content" title="\${tooltip}">
                            <div class="icon-box">
                                <span class="codicon codicon-chevron-right toggle-icon" onclick="toggle('\${node.id}')"></span>
                            </div>
                            <div class="icon-box">
                                <span class="codicon codicon-symbol-method"></span>
                            </div>
                            <div class="text-group">
                                <span class="name">\${escape(node.name)}</span>
                                <span class="detail">\${escape(node.detail)}</span>
                            </div>
                        </div>
                        <div class="children" id="c-\${node.id}"></div>\`;
                    
                    const content = el.querySelector('.node-content');
                    content.addEventListener('click', (e) => {
                        if (!e.target.classList.contains('toggle-icon')) {
                            open(node);
                        }
                    });

                    container.appendChild(el);
                }

                function toggle(id) {
                    const el = document.getElementById('n-' + id);
                    const childBox = document.getElementById('c-' + id);
                    
                    if (el.classList.contains('expanded')) {
                        el.classList.remove('expanded');
                    } else {
                        el.classList.add('expanded');
                        if (!childBox.hasChildNodes()) {
                            childBox.innerHTML = '<div class="loading">Loading...</div>';
                            vscode.postMessage({ command: 'expand', id: id });
                        }
                    }
                }

                function finishLoad(pid, kids) {
                    const box = document.getElementById('c-' + pid);
                    box.innerHTML = '';
                    if (!kids || kids.length === 0) {
                        box.innerHTML = '<div class="loading">No incoming calls.</div>';
                        return;
                    }
                    kids.forEach(k => renderNode(box, k));
                }

                function open(n) {
                    vscode.postMessage({ command: 'open', uri: n.uri, sLine: n.range[0].line, sChar: n.range[0].character, eLine: n.range[1].line, eChar: n.range[1].character });
                }

                function escape(s) { return s ? s.replace(/</g, '&lt;') : ''; }

                vscode.postMessage({ command: 'ready' });
            `;

            panel.webview.html = getHtmlShell(panel.webview, context.extensionUri, `Calls: ${rootItem.name}`, '', script);

            // 【关键】：使用 selectionRange 仅选中函数名
            const rootData = {
                id: rootId, name: rootItem.name, detail: vscode.workspace.asRelativePath(rootItem.uri),
                uri: rootItem.uri.toString(), range: rootItem.selectionRange 
            };

            panel.webview.onDidReceiveMessage(async (msg) => {
                switch (msg.command) {
                    case 'ready':
                        panel.webview.postMessage({ command: 'setRoot', node: rootData });
                        break;
                    case 'expand':
                        const pItem = session.getItem(msg.id);
                        if (pItem) {
                            try {
                                const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', pItem);
                                const children = calls.map(c => ({
                                    id: session.registerItem(c.from), name: c.from.name, detail: vscode.workspace.asRelativePath(c.from.uri),
                                    uri: c.from.uri.toString(), range: c.fromRanges[0]
                                }));
                                panel.webview.postMessage({ command: 'appendChildren', parentId: msg.id, children });
                            } catch (e) { console.error(e); }
                        }
                        break;
                    case 'open':
                        openDocument(msg.uri, msg.sLine, msg.sChar, msg.eLine, msg.eChar);
                        break;
                }
            });
            panel.onDidDispose(() => session.dispose());

        } catch (e) { vscode.window.showErrorMessage("Error: " + e); }
    });
}

// =============================================================
//  通用辅助函数
// =============================================================

async function openDocument(uriStr: string, sLine: number, sChar: number, eLine: number, eChar: number) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(sLine, sChar, eLine, eChar), viewColumn: vscode.ViewColumn.One });
}

function escapeHtml(text: string) { 
    return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#039;'}[m] || m)); 
}