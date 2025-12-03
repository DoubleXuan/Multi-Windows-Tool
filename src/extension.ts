import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('multiRef.find', async () => handleFindReferences(context)));
    context.subscriptions.push(vscode.commands.registerCommand('multiRef.callHierarchy', async () => handleCallHierarchy(context)));
}
export function deactivate() {}

// =============================================================
//  通用外壳
// =============================================================
function getHtmlShell(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, bodyContent: string, specificScript: string) {
    const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon.css'));
    const visJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vis-network.min.js'));

    const csp = `
        default-src 'none'; 
        style-src ${webview.cspSource} 'unsafe-inline'; 
        script-src ${webview.cspSource} 'unsafe-inline'; 
        font-src ${webview.cspSource};
    `;

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <link href="${codiconCssUri}" rel="stylesheet" />
        <script src="${visJsUri}"></script>
        <style>
            body { padding:0; margin:0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            .toolbar { padding: 6px 10px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
            .title { font-weight: bold; font-size: 1.1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .btn-group { display: flex; gap: 5px; }
            .btn { background: none; border: 1px solid transparent; color: var(--vscode-icon-foreground); cursor: pointer; padding: 3px 6px; border-radius: 3px; display: flex; align-items: center; }
            .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
            .btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            .codicon { font-size: 16px; }
            .view-container { flex: 1; overflow: auto; position: relative; }
            #tree-view { padding: 10px; display: block; }
            #graph-view { width: 100%; height: 100%; display: none; background: #EAEAEA; }
            @media (prefers-color-scheme: dark) { #graph-view { background: #252526; } }
            
            /* Styles */
            .tree-node, .file-group { margin-left: 10px; }
            .node-content, .file-header { display: flex; align-items: center; cursor: pointer; padding: 4px; border-radius: 3px; white-space: nowrap; overflow: hidden; }
            .node-content:hover, .file-header:hover { background: var(--vscode-list-hoverBackground); }
            .text-group { flex: 1; display: flex; align-items: baseline; min-width: 0; overflow: hidden; }
            .name { font-weight: bold; margin-right: 6px; white-space: nowrap; }
            .detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .icon-box { width: 16px; height: 16px; display: flex; justify-content: center; align-items: center; margin-right: 4px; flex-shrink: 0; }
            .codicon-symbol-method { color: var(--vscode-symbolIcon-functionForeground); }
            .codicon-file-code { color: var(--vscode-symbolIcon-keywordForeground); }
            .codicon-file-text { color: var(--vscode-symbolIcon-interfaceForeground); }
            .codicon-file { opacity: 0.7; }
            .toggle-icon { transition: transform 0.2s; opacity: 0.8; }
            .toggle-icon:hover { color: var(--vscode-textLink-activeForeground); opacity: 1; }
            .expanded > .node-content .toggle-icon, .expanded > .file-header .toggle-icon { transform: rotate(90deg); }
            .children { display: none; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); margin-left: 8px; }
            .expanded > .children { display: block; }
            .ref-item { display: flex; align-items: center; padding: 3px 24px; cursor: pointer; white-space: nowrap; overflow: hidden; }
            .ref-item:hover { background: var(--vscode-list-hoverBackground); }
            .line-num { color: var(--vscode-descriptionForeground); margin-right: 10px; min-width: 40px; text-align: right; flex-shrink: 0; }
            .code-text { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family); opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .loading { padding-left: 20px; color: gray; font-style: italic; }
        </style>
    </head>
    <body>
        <div class="toolbar">
            <div class="title" title="${title}">${title}</div>
            <div class="btn-group">
                <button class="btn active" id="btn-tree" onclick="switchView('tree')" title="列表模式"><span class="codicon codicon-list-tree"></span></button>
                <button class="btn" id="btn-graph" onclick="switchView('graph')" title="关系图模式"><span class="codicon codicon-graph"></span></button>
            </div>
        </div>
        <div class="view-container">
            <div id="tree-view">${bodyContent}</div>
            <div id="graph-view"></div>
        </div>
        <script>
            const vscode = acquireVsCodeApi();
            function switchView(mode) {
                const t = document.getElementById('tree-view'), g = document.getElementById('graph-view');
                if (mode === 'tree') { t.style.display='block'; g.style.display='none'; document.getElementById('btn-tree').classList.add('active'); document.getElementById('btn-graph').classList.remove('active'); }
                else { t.style.display='none'; g.style.display='block'; document.getElementById('btn-tree').classList.remove('active'); document.getElementById('btn-graph').classList.add('active'); if(network) network.fit(); }
            }
            ${specificScript}
        </script>
    </body>
    </html>`;
}

// =============================================================
//  功能 A: Find References
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
            if (!locations?.length) { vscode.window.showInformationMessage(`未找到 '${word}' 的引用`); return; }

            const panel = vscode.window.createWebviewPanel('multiRefWindow', `Ref: ${word}`, vscode.ViewColumn.Beside, {
                enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            });

            const fileGroups = await processRefLocations(locations);
            const listHtml = fileGroups.map(file => `
                <div class="file-group expanded">
                    <div class="file-header" title="${escapeHtml(file.filePath)}" onclick="this.parentElement.classList.toggle('expanded')">
                        <div class="icon-box"><span class="codicon codicon-chevron-right toggle-icon"></span></div>
                        <div class="icon-box"><span class="codicon ${file.iconClass}"></span></div>
                        <div class="text-group"><span class="name">${escapeHtml(file.filePath)}</span><span class="detail">(${file.items.length})</span></div>
                    </div>
                    <div class="children" style="display:block">
                        ${file.items.map((r: any) => `
                            <div class="ref-item" title="${escapeHtml(r.text)}" onclick="openLoc('${r.uri}', ${r.range.start.line}, ${r.range.start.character}, ${r.range.end.line}, ${r.range.end.character})">
                                <span class="line-num">${r.line + 1}:</span><span class="code-text">${escapeHtml(r.text)}</span>
                            </div>`).join('')}
                    </div>
                </div>`).join('');

            const script = `
                function openLoc(uri, sLine, sChar, eLine, eChar) { vscode.postMessage({command: 'open', uri, sLine, sChar, eLine, eChar}); }
                document.getElementById('btn-graph').style.display = 'none'; 
            `;
            panel.webview.html = getHtmlShell(panel.webview, context.extensionUri, `Ref: ${word}`, listHtml, script);
            panel.webview.onDidReceiveMessage(msg => { if (msg.command === 'open') openDocument(msg.uri, msg.sLine, msg.sChar, msg.eLine, msg.eChar); });
        } catch (e) { vscode.window.showErrorMessage("Error: " + e); }
    });
}

// =============================================================
//  功能 B: Call Hierarchy (S型导线 + 网格对齐 + 智能行号)
// =============================================================
class HierarchySession {
    private idMap = new Map<string, vscode.CallHierarchyItem>();
    registerItem(item: vscode.CallHierarchyItem) { const id = 'id_' + Math.random().toString(36).substr(2, 9); this.idMap.set(id, item); return id; }
    getItem(id: string) { return this.idMap.get(id); }
    dispose() { this.idMap.clear(); }
}

async function handleCallHierarchy(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "正在分析..." }, async () => {
        try {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', editor.document.uri, editor.selection.active);
            if (!items || (Array.isArray(items) && items.length === 0)) { vscode.window.showInformationMessage('未找到调用层级信息'); return; }

            const rootItem = Array.isArray(items) ? items[0] : items;
            const session = new HierarchySession();
            const rootId = session.registerItem(rootItem);

            const panel = vscode.window.createWebviewPanel('callHierarchyWindow', `Calls: ${rootItem.name}`, vscode.ViewColumn.Beside, {
                enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            });

            const script = `
                let network = null, nodes = new vis.DataSet([]), edges = new vis.DataSet([]);
                let expandedNodes = new Set(); 

                window.addEventListener('message', e => {
                    const m = e.data;
                    if(m.command === 'setRoot') { renderTreeNode(document.getElementById('root'), m.node); initGraph(m.node); }
                    if(m.command === 'appendChildren') { handleExpandSuccess(m.parentId, m.children); }
                });

                function toggleExpand(nodeId) {
                    if (expandedNodes.has(nodeId)) performCollapse(nodeId);
                    else performExpand(nodeId);
                }
                function performExpand(nodeId) {
                    const box = document.getElementById('c-' + nodeId);
                    if(box) { document.getElementById('n-' + nodeId).classList.add('expanded'); box.innerHTML = '<div class="loading">Loading...</div>'; }
                    const node = nodes.get(nodeId);
                    if(node) nodes.update({ id: nodeId, label: getLabel(node.rawData.name, '...', node.callLines) });
                    vscode.postMessage({ command: 'expand', id: nodeId });
                }
                function performCollapse(nodeId) {
                    expandedNodes.delete(nodeId);
                    const node = nodes.get(nodeId);
                    if(node) nodes.update({ id: nodeId, label: getLabel(node.rawData.name, '[+]', node.callLines) });
                    removeGraphChildrenRecursively(nodeId);
                    const treeEl = document.getElementById('n-' + nodeId), treeBox = document.getElementById('c-' + nodeId);
                    if(treeEl) treeEl.classList.remove('expanded');
                    if(treeBox) treeBox.innerHTML = ''; 
                }
                function handleExpandSuccess(parentId, children) {
                    expandedNodes.add(parentId);
                    const treeBox = document.getElementById('c-' + parentId);
                    if(treeBox) {
                        treeBox.innerHTML = ''; 
                        if (!children || children.length === 0) treeBox.innerHTML = '<div class="loading">无调用者</div>';
                        else children.forEach(k => renderTreeNode(treeBox, k));
                    }
                    const parentNode = nodes.get(parentId);
                    if(parentNode) {
                        nodes.update({ id: parentId, label: getLabel(parentNode.rawData.name, '[-]', parentNode.callLines) });
                        if (children && children.length > 0) {
                            const newNodes = [], newEdges = [];
                            children.forEach(child => {
                                if (!nodes.get(child.id)) {
                                    newNodes.push({
                                        id: child.id,
                                        label: getLabel(child.name, '[+]', child.callLines),
                                        title: child.name + '\\n' + child.detail,
                                        rawData: child,
                                        callLines: child.callLines,
                                        color: { background: '#FDFDFD', border: '#666' },
                                        font: { multi: true, align: 'left' }
                                    });
                                    newEdges.push({ from: parentId, to: child.id });
                                }
                            });
                            nodes.add(newNodes); edges.add(newEdges);
                        }
                    }
                }

                function renderTreeNode(container, node) {
                    const el = document.createElement('div'); el.className = 'tree-node'; el.id = 'n-' + node.id;
                    const tooltip = escape(node.name) + ' (' + escape(node.detail) + ')';
                    el.innerHTML = \`
                        <div class="node-content" title="\${tooltip}">
                            <div class="icon-box"><span class="codicon codicon-chevron-right toggle-icon" onclick="toggleExpand('\${node.id}')"></span></div>
                            <div class="icon-box"><span class="codicon codicon-symbol-method"></span></div>
                            <div class="text-group"><span class="name">\${escape(node.name)}</span><span class="detail">\${escape(node.detail)}</span></div>
                        </div>
                        <div class="children" id="c-\${node.id}"></div>\`;
                    el.querySelector('.node-content').addEventListener('click', (e) => { 
                        if (!e.target.classList.contains('toggle-icon')) open(node.uri, node.range); 
                    });
                    container.appendChild(el);
                }

                // --- Graph View 逻辑 ---
                function getSimpleName(fullName) { return fullName.split('(')[0].trim(); }
                
                // 【核心优化 1】行号显示逻辑：只有行数 > 1 才显示列表
                function getLabel(name, state, callLines) {
                    let label = getSimpleName(name);
                    if(state) label += ' ' + state;
                    
                    if (callLines && callLines.length > 1) { // 只有大于1次调用才显示详情
                        label += '\\n----------------'; 
                        const maxShow = 6;
                        for (let i = 0; i < Math.min(callLines.length, maxShow); i++) {
                            label += '\\n ' + (i + 1) + '. line ' + callLines[i];
                        }
                        if (callLines.length > maxShow) label += '\\n ... (' + (callLines.length - maxShow) + ' more)';
                    }
                    return label;
                }

                function initGraph(rootNode) {
                    const container = document.getElementById('graph-view');
                    nodes.clear(); edges.clear(); expandedNodes.clear();
                    
                    nodes.add({
                        id: rootNode.id,
                        label: getLabel(rootNode.name, '[+]'),
                        title: rootNode.name + '\\n' + rootNode.detail,
                        color: { background: '#DCE775', border: '#33691E' }, 
                        shape: 'box',
                        rawData: rootNode,
                        callLines: [],
                        font: { size: 14, face: 'sans-serif', align: 'left', multi: true }
                    });

                    const data = { nodes: nodes, edges: edges };
                    const options = {
                        layout: {
                            hierarchical: {
                                direction: 'LR',
                                sortMethod: 'directed',
                                levelSeparation: 300, 
                                nodeSpacing: 60,
                                treeSpacing: 70,
                                blockShifting: true,
                                edgeMinimization: false, 
                                parentCentralization: true,
                                shakeTowards: 'roots'
                            }
                        },
                        physics: { enabled: false },
                        interaction: { hover: true, navigationButtons: true, keyboard: false },
                        edges: {
                            smooth: {
                                enabled: true,
                                type: 'cubicBezier', 
                                forceDirection: 'horizontal', 
                                roundness: 0.6 
                            },
                            color: { color: '#C0392B', highlight: '#E74C3C' },
                            arrows: { from: { enabled: true, type: 'arrow', scaleFactor: 0.6 } },
                            width: 1.5
                        },
                        nodes: {
                            shape: 'box',
                            margin: 10,
                            borderWidth: 1,
                            shadow: { enabled: true, size: 2, x: 2, y: 2 },
                            widthConstraint: { maximum: 220 } 
                        }
                    };
                    network = new vis.Network(container, data, options);

                    // 【核心优化 2】点击行为分离：坐标嗅探
                    network.on("click", function (params) {
                        if (params.nodes.length === 1) {
                            const nodeId = params.nodes[0];
                            const node = nodes.get(nodeId);
                            
                            // 获取节点在 Canvas 上的边界框
                            const box = network.getBoundingBox(nodeId);
                            const clickX = params.pointer.canvas.x;
                            const clickY = params.pointer.canvas.y;
                            
                            // 逻辑：如果点击区域位于节点最右侧 25% 的区域（通常是 [+] 所在位置），且位于上半部分（标题行）
                            // 这是一个估算，因为 [+] 紧跟在名字后面。
                            // 更稳妥的逻辑：点击整个节点是跳转，点击 [+/-] 是展开。
                            // 但由于 Canvas 无法精确识别文字，我们约定：
                            // 1. 点击节点主区域 -> 跳转代码
                            // 2. 点击节点右侧边缘区域 -> 展开/收起
                            
                            const nodeWidth = box.right - box.left;
                            const nodeHeight = box.bottom - box.top;
                            
                            // 定义右侧 35% 区域为“展开区”
                            const isExpandZone = (clickX > box.left + (nodeWidth * 0.65)) && (clickY < box.top + 30); // 30px 是大概的一行高度

                            if (isExpandZone) {
                                toggleExpand(nodeId);
                            } else {
                                // 跳转逻辑
                                if(node.rawData) open(node.rawData.uri, node.rawData.range);
                            }
                        }
                    });
                    
                    network.on("oncontext", function (params) {
                         const nodeId = this.getNodeAt(params.pointer.DOM);
                         if(nodeId) { const node = nodes.get(nodeId); if(node.rawData) open(node.rawData.uri, node.rawData.range); }
                         params.event.preventDefault();
                    });
                }

                function removeGraphChildrenRecursively(parentId) {
                    const connectedEdges = network.getConnectedEdges(parentId);
                    const childIds = [];
                    connectedEdges.forEach(edgeId => {
                        const edge = edges.get(edgeId);
                        if (edge.from === parentId) childIds.push(edge.to);
                    });
                    childIds.forEach(childId => {
                        removeGraphChildrenRecursively(childId);
                        nodes.remove(childId);
                        expandedNodes.delete(childId);
                    });
                }

                function open(uri, range) { 
                    // range 可能是对象或数组，这里做个兼容
                    let sLine = 0, sChar = 0, eLine = 0, eChar = 0;
                    if (range) {
                        // 如果是 CallHierarchyIncomingCall.fromRanges[0]
                        if (range.start) { sLine = range.start.line; sChar = range.start.character; eLine = range.end.line; eChar = range.end.character; }
                        // 如果是 Array (历史遗留)
                        else if (range[0]) { sLine = range[0].line; sChar = range[0].character; eLine = range[1].line; eChar = range[1].character; }
                    }
                    vscode.postMessage({ command: 'open', uri: uri, sLine, sChar, eLine, eChar }); 
                }
                function escape(s) { return s ? s.replace(/</g, '&lt;') : ''; }
                vscode.postMessage({ command: 'ready' });
            `;
            panel.webview.html = getHtmlShell(panel.webview, context.extensionUri, `Calls: ${rootItem.name}`, '<div id="root"></div>', script);
            
            const rootData = { id: rootId, name: rootItem.name, detail: vscode.workspace.asRelativePath(rootItem.uri), uri: rootItem.uri.toString(), range: rootItem.selectionRange };
            
            panel.webview.onDidReceiveMessage(async (msg) => {
                switch (msg.command) {
                    case 'ready': panel.webview.postMessage({ command: 'setRoot', node: rootData }); break;
                    case 'expand':
                        const pItem = session.getItem(msg.id);
                        if (pItem) {
                            try {
                                const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', pItem);
                                const children = calls.map(c => ({
                                    id: session.registerItem(c.from), name: c.from.name, detail: vscode.workspace.asRelativePath(c.from.uri),
                                    uri: c.from.uri.toString(), 
                                    range: c.fromRanges[0], // 这是为了点击跳转用的，跳到第一个调用点
                                    callLines: c.fromRanges.map(r => r.start.line + 1)
                                }));
                                panel.webview.postMessage({ command: 'appendChildren', parentId: msg.id, children });
                            } catch (e) { console.error(e); }
                        }
                        break;
                    case 'open': openDocument(msg.uri, msg.sLine, msg.sChar, msg.eLine, msg.eChar); break;
                }
            });
            panel.onDidDispose(() => session.dispose());
        } catch (e) { vscode.window.showErrorMessage("Error: " + e); }
    });
}

// 辅助函数
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
        const ext = path.extname(g.uri.fsPath).toLowerCase();
        let iconClass = 'codicon-file';
        if (['.c', '.cpp', '.cxx', '.cc', '.m', '.mm'].includes(ext)) iconClass = 'codicon-file-code';
        else if (['.h', '.hpp', '.hxx'].includes(ext)) iconClass = 'codicon-file-text';
        res.push({
            filePath: vscode.workspace.asRelativePath(g.uri),
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
async function openDocument(uriStr: string, sLine: number, sChar: number, eLine: number, eChar: number) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(sLine, sChar, eLine, eChar), viewColumn: vscode.ViewColumn.One });
}
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#039;'}[m] || m)); }