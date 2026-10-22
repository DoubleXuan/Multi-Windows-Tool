import { GraphModel, Occurrence } from '../src/graph';
import { CodeLocation, Direction, HostMessage, SymbolData } from '../src/protocol';
import type ELKConstructor from 'elkjs/lib/elk-api';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';

declare const ELK: typeof ELKConstructor;
interface SavedView {
    root?: SymbolData; follow: boolean; view: 'graph' | 'tree';
    expanded: { id: string; symbolId: string; direction: Direction; visibleCount?: number }[];
    openSites: string[];
}
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): SavedView | undefined; setState(state: SavedView): void };
const vscode = acquireVsCodeApi();
const elk = new ELK();
const post = (message: unknown) => vscode.postMessage(message);
const app = document.getElementById('app')!;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(text: string, title: string, action: () => void, className = '') {
    const node = element('button', className, text); node.type = 'button'; node.title = title; node.addEventListener('click', action); return node;
}
function svgElement<K extends keyof SVGElementTagNameMap>(tag: K) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

const toolbar = element('div', 'toolbar');
const back = button('←', '后退', () => post({ type: 'back' }));
const forward = button('→', '前进', () => post({ type: 'forward' }));
back.disabled = forward.disabled = true;
const title = element('strong', 'title', '调用关系');
const followButton = button('已锁定', '切换：锁定根节点 / 跟随编辑器光标', () => post({ type: 'follow', value: !follow }));
const graphButton = button('关系图', '显示关系图', () => setView('graph'));
const treeButton = button('列表', '显示调用关系列表', () => setView('tree'));
const search = element('input', 'search'); search.type = 'search'; search.placeholder = '查找已展开的函数'; search.setAttribute('aria-label', search.placeholder);
toolbar.append(back, forward, title,
    button('当前符号', '以代码编辑器当前符号为中心', () => post({ type: 'current' })),
    followButton, button('刷新', '清空缓存并重新分析当前根符号', () => post({ type: 'refresh' })),
    graphButton, treeButton, button('−', '缩小', () => zoomAt(.8)), button('+', '放大', () => zoomAt(1.25)),
    button('适应窗口', '缩放并居中显示全部已展开节点', () => fit()),
    button('SVG', '导出当前图像（含节点文字）', () => exportSvg()),
    button('JSON', '导出当前已展开的符号、关系和调用位置', () => exportJson()), search);
const legend = element('div', 'legend', '左侧：调用者　→　当前函数　→　右侧：被调用者　｜　函数名跳定义 · 行号跳调用点 · ◎ 设为中心 · 拖动空白处平移 · Ctrl/⌘ + 滚轮缩放');
const status = element('div', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
const viewport = element('div', 'viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', '调用关系图，可使用方向键平移');
const world = element('div', 'world');
const lines = svgElement('svg'); lines.classList.add('edges');
const cards = element('div', 'cards');
world.append(lines, cards); viewport.append(world);
const tree = element('div', 'tree'); tree.hidden = true;
app.append(toolbar, legend, status, viewport, tree);
const measure = element('div', 'measure'); app.append(measure);

let model: GraphModel | undefined;
let generation = 0, follow = false, stale = false;
let view: 'graph' | 'tree' = 'graph';
let layoutTicket = 0;
let x = 24, y = 24, scale = 1;
let bounds = { width: 1, height: 1 };
let fitted = false;
let layoutPositions = new Map<string, { x: number; y: number }>();
let pendingAnchor: { id: string; x: number; y: number; viewX: number; viewY: number } | undefined;
let savedView = vscode.getState();
let restoring: SavedView['expanded'] = [];

function persist() {
    if (!model) return;
    vscode.setState({
        root: model.occurrences.get('root')!.symbol, follow, view,
        expanded: [...model.occurrences.values()].flatMap(node => (['incoming', 'outgoing'] as Direction[]).filter(direction => node[direction].expanded).map(direction => ({ id: node.id, symbolId: node.symbol.id, direction, visibleCount: node[direction].visibleCount }))),
        openSites: [...openSites]
    });
}
function resumeBranches() {
    if (!model || !restoring.length) return;
    const remaining: SavedView['expanded'] = [];
    for (const saved of restoring) {
        const node = model.occurrences.get(saved.id);
        if (!node) { remaining.push(saved); continue; }
        if (node.symbol.id !== saved.symbolId || node.recursive) continue;
        node[saved.direction].visibleCount = Math.min(400, Math.max(20, saved.visibleCount || 20));
        const requestId = model.begin(saved.id, saved.direction);
        if (requestId !== undefined) post({ type: 'expand', generation, requestId, occurrenceId: saved.id, symbolId: saved.symbolId, direction: saved.direction });
    }
    restoring = remaining;
}

function setView(mode: 'graph' | 'tree') {
    view = mode; viewport.hidden = mode !== 'graph'; tree.hidden = mode !== 'tree';
    graphButton.classList.toggle('active', mode === 'graph'); treeButton.classList.toggle('active', mode === 'tree');
    if (mode === 'graph' && !fitted) requestAnimationFrame(fit);
    if (model) { persist(); if (mode === 'graph') void render(); }
}
setView('graph');
function updateTransform() { world.style.transform = `translate(${x}px,${y}px) scale(${scale})`; }
function fit() {
    if (!model || view !== 'graph' || !viewport.clientWidth || !layoutPositions.size) return;
    scale = Math.min(1.15, Math.max(.12, Math.min((viewport.clientWidth - 48) / bounds.width, (viewport.clientHeight - 48) / bounds.height)));
    x = (viewport.clientWidth - bounds.width * scale) / 2; y = (viewport.clientHeight - bounds.height * scale) / 2;
    fitted = true; updateTransform();
}
function zoomAt(factor: number, px = viewport.clientWidth / 2, py = viewport.clientHeight / 2) {
    const next = Math.min(2.5, Math.max(.12, scale * factor));
    x = px - (px - x) * next / scale; y = py - (py - y) * next / scale; scale = next; updateTransform();
}
viewport.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault(); const box = viewport.getBoundingClientRect(); zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - box.left, event.clientY - box.top);
    }
}, { passive: false });
let pan: { id: number; x: number; y: number; startX: number; startY: number } | undefined;
viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('.card')) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: x, startY: y }; viewport.setPointerCapture(event.pointerId); viewport.classList.add('panning');
});
viewport.addEventListener('pointermove', event => { if (pan) { x = pan.startX + event.clientX - pan.x; y = pan.startY + event.clientY - pan.y; updateTransform(); } });
const endPan = () => { pan = undefined; viewport.classList.remove('panning'); };
viewport.addEventListener('pointerup', endPan); viewport.addEventListener('pointercancel', endPan);
viewport.addEventListener('keydown', event => {
    if (event.target !== viewport) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (moves[event.key]) { event.preventDefault(); x += moves[event.key][0]; y += moves[event.key][1]; updateTransform(); }
});

function rememberAnchor(id: string) {
    const point = layoutPositions.get(id);
    if (point) pendingAnchor = { id, ...point, viewX: x, viewY: y };
}
function toggle(id: string, direction: Direction) {
    if (!model || stale) return;
    const node = model.occurrences.get(id)!;
    rememberAnchor(id);
    if (node[direction].expanded && node[direction].state !== 'error') model.collapse(id, direction);
    else {
        // Keep exploration bounded. Users can re-center a branch to continue.
        if (model.visible().length >= 400 && node[direction].state !== 'loaded') {
            status.textContent = '已展开较多节点，请先收起分支，或将某个函数设为中心继续探索。'; return;
        }
        const requestId = model.begin(id, direction);
        if (requestId !== undefined) post({ type: 'expand', generation, requestId, occurrenceId: id, symbolId: node.symbol.id, direction });
    }
    void render();
}
function navigate(location: CodeLocation) { post({ type: 'open', location }); }
function nodeCard(node: Occurrence, isTree = false): HTMLElement {
    const card = element('article', isTree ? 'tree-card' : 'card'); card.dataset.id = node.id;
    card.classList.toggle('root', node.id === 'root'); card.classList.toggle('recursive', node.recursive);
    const heading = element('div', 'node-heading');
    const name = button(node.symbol.name, `跳转到定义：${node.symbol.name}`, () => navigate({ uri: node.symbol.uri, range: node.symbol.range }), 'symbol');
    const center = button('◎', '以此函数为中心查看关系', () => post({ type: 'reroot', generation, symbolId: node.symbol.id, symbol: node.symbol }), 'reroot');
    heading.append(name, center);
    const detail = element('div', 'detail', `${node.symbol.detail}:${node.symbol.range.start.line + 1}`); detail.title = detail.textContent || '';
    card.append(heading, detail);
    if (node.relation) {
        const relation = node.relation;
        const sites = element('details', 'sites');
        // Expansion state is restored across redraws.
        sites.open = openSites.has(node.id);
        sites.addEventListener('toggle', () => {
            if (!sites.isConnected) return;
            const changed = openSites.has(node.id) !== sites.open;
            if (sites.open) openSites.add(node.id); else openSites.delete(node.id);
            if (changed) { persist(); if (!isTree) { rememberAnchor(node.id); void render(); } }
        });
        sites.append(element('summary', '', `${relation.sites.length} 个调用位置${node.direction === 'outgoing' ? '（在上级函数中）' : ''}`));
        const list = element('div', 'site-list');
        relation.sites.forEach(site => {
            const label = `${site.uri.split('/').pop() || ''}:${site.range.start.line + 1}:${site.range.start.character + 1}`;
            const link = button(label, `${decodeUri(site.uri)}，第 ${site.range.start.line + 1} 行`, () => navigate(site), 'site'); list.append(link);
        });
        if (!relation.sites.length) list.append(element('span', 'detail', '语言服务未提供调用位置'));
        sites.append(list); card.append(sites);
    }
    if (node.recursive) card.append(element('div', 'recursion', '↩ 递归 / 当前路径已出现，停止展开'));
    else {
        const controls = element('div', 'node-controls');
        // Each side is an exploration tree; reverse-direction exploration uses re-center.
        const directions: Direction[] = node.direction ? [node.direction] : ['incoming', 'outgoing'];
        for (const direction of directions) {
            const state = node[direction];
            const label = direction === 'incoming' ? '调用者' : '被调用者';
            const text = state.state === 'loading' ? `${label} 查询中…` : state.state === 'error' ? `${label} 重试` : `${state.expanded ? '−' : '+'} ${label}${state.state === 'loaded' ? ` (${state.children.length})` : ''}`;
            const control = button(text, state.error || `${state.expanded ? '收起' : '展开'}${label}`, () => toggle(node.id, direction));
            control.disabled = stale || state.state === 'loading'; controls.append(control);
            if (state.expanded && state.children.length > state.visibleCount) {
                const more = button(`再显示 ${Math.min(20, state.children.length - state.visibleCount)} 个${label}`, '分批显示更多关系，避免大图一次渲染过多节点', () => {
                    if (!model || model.visible().length >= 400) { status.textContent = '请先收起部分分支，或以某个函数为中心继续查看。'; return; }
                    rememberAnchor(node.id); model.showMore(node.id, direction); void render();
                });
                more.disabled = stale; controls.append(more);
            }
            if (state.state === 'error') card.append(element('div', 'error', state.error));
            if (state.expanded && state.state === 'loaded' && !state.children.length) card.append(element('div', 'empty', `语言服务未返回${label}`));
        }
        card.append(controls);
    }
    const needle = search.value.trim().toLocaleLowerCase();
    card.classList.toggle('match', !!needle && `${node.symbol.name} ${node.symbol.detail}`.toLocaleLowerCase().includes(needle));
    return card;
}
function decodeUri(uri: string) { try { return decodeURIComponent(uri); } catch { return uri; } }
const openSites = new Set<string>();

function renderTree() {
    tree.replaceChildren();
    if (!model) return;
    const append = (id: string, parent: HTMLElement) => {
        const node = model!.occurrences.get(id)!;
        const item = element('div', 'tree-item'); item.append(nodeCard(node, true)); parent.append(item);
        for (const direction of ['incoming', 'outgoing'] as Direction[]) {
            if (!node[direction].expanded || !node[direction].children.length) continue;
            const children = element('div', 'tree-children');
            children.append(element('div', 'branch-label', direction === 'incoming' ? '← 调用者' : '→ 被调用者'));
            node[direction].children.slice(0, node[direction].visibleCount).forEach(child => append(child, children)); item.append(children);
        }
    };
    append('root', tree);
}

async function render() {
    if (!model) return;
    const ticket = ++layoutTicket;
    const currentModel = model;
    persist();
    renderTree();
    const visible = currentModel.visible();
    const renderedCards = visible.map(node => nodeCard(node));
    measure.replaceChildren(...renderedCards);
    const sizes = new Map<string, { width: number; height: number }>();
    measure.querySelectorAll<HTMLElement>('.card').forEach(card => sizes.set(card.dataset.id!, { width: card.offsetWidth, height: card.offsetHeight }));
    cards.replaceChildren(...renderedCards);
    const sideNodes = (direction: Direction) => visible.filter(node => node.id !== 'root' && node.id.split('/')[1] === direction);
    const layoutSide = async (direction: Direction): Promise<ElkNode> => {
        const children = [visible[0], ...sideNodes(direction)];
        const ids = new Set(children.map(node => node.id));
        const edges: ElkExtendedEdge[] = children.filter(node => node.parent && ids.has(node.parent)).map(node => ({ id: `edge:${node.id}`, sources: [node.parent!], targets: [node.id] }));
        return elk.layout({ id: direction, layoutOptions: {
            'elk.algorithm': 'layered', 'elk.direction': direction === 'incoming' ? 'LEFT' : 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.nodeNode': '24',
            'elk.layered.spacing.nodeNodeBetweenLayers': '90',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES'
        }, children: children.map(node => ({ id: node.id, ...sizes.get(node.id)! })), edges });
    };
    try {
        const [left, right] = await Promise.all([layoutSide('incoming'), layoutSide('outgoing')]);
        if (ticket !== layoutTicket || model !== currentModel) return;
        const rootLeft = left.children!.find(node => node.id === 'root')!;
        const rootRight = right.children!.find(node => node.id === 'root')!;
        const anchorY = Math.max(rootLeft.y!, rootRight.y!);
        const offsets = [
            { graph: left, dx: 24, dy: 24 + anchorY - rootLeft.y! },
            { graph: right, dx: 24 + rootLeft.x! - rootRight.x!, dy: 24 + anchorY - rootRight.y! }
        ];
        const positions = new Map<string, { x: number; y: number }>();
        let width = 0, height = 0;
        for (const { graph, dx, dy } of offsets) {
            for (const node of graph.children!) {
                const point = { x: node.x! + dx, y: node.y! + dy }; positions.set(node.id, point);
                width = Math.max(width, point.x + node.width!); height = Math.max(height, point.y + node.height!);
            }
        }
        layoutPositions = positions; bounds = { width: width + 24, height: height + 24 };
        for (const card of Array.from(cards.querySelectorAll<HTMLElement>('.card'))) {
            const point = positions.get(card.dataset.id!)!; card.style.left = `${point.x}px`; card.style.top = `${point.y}px`;
        }
        drawEdges(offsets);
        lines.setAttribute('width', String(bounds.width)); lines.setAttribute('height', String(bounds.height));
        world.style.width = `${bounds.width}px`; world.style.height = `${bounds.height}px`;
        if (pendingAnchor) {
            const next = positions.get(pendingAnchor.id);
            if (next) { x = pendingAnchor.viewX + (pendingAnchor.x - next.x) * scale; y = pendingAnchor.viewY + (pendingAnchor.y - next.y) * scale; }
            pendingAnchor = undefined;
        }
        if (!fitted) fit(); else updateTransform();
    } catch (error) {
        if (ticket !== layoutTicket) return;
        status.textContent = `布局失败，可切换列表继续查看：${String(error)}`;
        setView('tree');
    }
}
function drawEdges(layouts: { graph: ElkNode; dx: number; dy: number }[]) {
    lines.replaceChildren();
    const defs = svgElement('defs');
    const marker = svgElement('marker'); marker.id = 'arrow'; marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7'); marker.setAttribute('orient', 'auto-start-reverse');
    const triangle = svgElement('path'); triangle.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); triangle.setAttribute('fill', 'var(--edge-color)'); marker.append(triangle); defs.append(marker); lines.append(defs);
    for (const { graph, dx, dy } of layouts) {
        for (const edge of graph.edges || []) for (const section of edge.sections || []) {
            const points = [section.startPoint, ...section.bendPoints || [], section.endPoint];
            // Layout edges point away from the root. Call arrows on the left
            // point in the opposite direction: caller -> callee.
            if (graph.id === 'incoming') points.reverse();
            const path = svgElement('path');
            path.setAttribute('d', points.map((point, index) => `${index ? 'L' : 'M'} ${point.x + dx} ${point.y + dy}`).join(' '));
            path.setAttribute('marker-end', 'url(#arrow)'); path.classList.add('edge'); lines.append(path);
        }
    }
}
search.addEventListener('input', () => {
    const needle = search.value.trim().toLocaleLowerCase();
    for (const card of Array.from(app.querySelectorAll<HTMLElement>('.card, .tree-card'))) {
        const node = model?.occurrences.get(card.dataset.id!);
        card.classList.toggle('match', !!needle && !!node && `${node.symbol.name} ${node.symbol.detail}`.toLocaleLowerCase().includes(needle));
    }
});
search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const match = cards.querySelector<HTMLElement>('.match');
    const point = match && layoutPositions.get(match.dataset.id!);
    if (point && match) { x = viewport.clientWidth / 2 - (point.x + match.offsetWidth / 2) * scale; y = viewport.clientHeight / 2 - (point.y + match.offsetHeight / 2) * scale; updateTransform(); }
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'root') {
        generation = message.generation; stale = false; model = new GraphModel(message.symbol); follow = message.follow;
        back.disabled = !message.canBack; forward.disabled = !message.canForward;
        title.textContent = message.symbol.name; title.title = message.symbol.detail;
        followButton.textContent = follow ? '跟随光标' : '已锁定'; followButton.classList.toggle('active', follow);
        status.textContent = ''; openSites.clear(); fitted = false; pendingAnchor = undefined; layoutPositions.clear();
        const restore = savedView?.root?.id === message.symbol.id ? savedView : undefined;
        if (restore) {
            restoring = restore.expanded || [];
            (restore.openSites || []).forEach(id => openSites.add(id));
            setView(restore.view || 'graph');
        } else restoring = [];
        savedView = undefined;
        for (const direction of ['incoming', 'outgoing'] as Direction[]) {
            if (!restore || restore.expanded.some(saved => saved.id === 'root' && saved.direction === direction)) toggle('root', direction);
        }
        void render();
    } else if (message.type === 'children' && message.generation === generation && !stale) {
        if (model?.accept(message.occurrenceId, message.direction, message.requestId, message.relations)) { resumeBranches(); rememberAnchor(message.occurrenceId); void render(); }
    } else if (message.type === 'queryError' && message.generation === generation && !stale) {
        if (model?.fail(message.occurrenceId, message.direction, message.requestId, message.message)) { rememberAnchor(message.occurrenceId); void render(); }
    } else if (message.type === 'status') status.textContent = message.message;
    else if (message.type === 'follow') { follow = message.value; followButton.textContent = follow ? '跟随光标' : '已锁定'; followButton.classList.toggle('active', follow); persist(); }
    else if (message.type === 'invalidate') { stale = true; generation = message.generation; void render(); }
    else if (message.type === 'references') {
        toolbar.hidden = legend.hidden = viewport.hidden = true; tree.hidden = false; status.textContent = message.title;
        tree.replaceChildren();
        for (const group of message.groups) {
            const file = element('details', 'reference-file'); file.open = true;
            file.append(element('summary', '', `${group.path} (${group.items.length})`));
            for (const item of group.items) file.append(button(`${item.range.start.line + 1}: ${item.text}`, item.text, () => navigate({ uri: item.uri, range: item.range }), 'reference'));
            tree.append(file);
        }
    }
});
function exportJson() {
    if (!model) return;
    const visible = model.visible();
    const symbols = [...new Map(visible.map(node => [node.symbol.id, node.symbol])).values()];
    const relations = [...new Map(visible.filter(node => node.relation).map(node => [JSON.stringify([node.relation!.callerId, node.relation!.calleeId]), node.relation])).values()];
    post({ type: 'export', format: 'json', content: JSON.stringify({ version: 1, root: model.occurrences.get('root')!.symbol.id, symbols, relations }, null, 2) });
}
function exportSvg() {
    if (!model || !layoutPositions.size) return;
    const output = svgElement('svg'); output.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    output.setAttribute('width', String(bounds.width)); output.setAttribute('height', String(bounds.height)); output.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    const background = svgElement('rect'); background.setAttribute('width', '100%'); background.setAttribute('height', '100%'); background.setAttribute('fill', getComputedStyle(document.body).backgroundColor); output.append(background);
    const styledClone = (source: Element): Element => {
        const clone = source.cloneNode(false) as HTMLElement | SVGElement;
        const computed = getComputedStyle(source);
        const properties = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'display', 'align-items', 'justify-content', 'flex', 'flex-shrink', 'flex-wrap', 'gap', 'padding', 'margin', 'border', 'border-radius', 'width', 'max-width', 'min-width', 'height', 'max-height', 'overflow', 'overflow-wrap', 'white-space', 'text-align', 'text-overflow', 'fill', 'stroke', 'stroke-width'];
        properties.forEach(property => clone.style.setProperty(property, computed.getPropertyValue(property)));
        source.childNodes.forEach(child => clone.append(child instanceof Element ? styledClone(child) : child.cloneNode(true)));
        return clone;
    };
    const edgeGroup = svgElement('g');
    Array.from(lines.children).forEach(child => edgeGroup.append(styledClone(child))); output.append(edgeGroup);
    for (const card of Array.from(cards.querySelectorAll<HTMLElement>('.card'))) {
        const point = layoutPositions.get(card.dataset.id!)!;
        const foreign = svgElement('foreignObject');
        foreign.setAttribute('x', String(point.x)); foreign.setAttribute('y', String(point.y)); foreign.setAttribute('width', String(card.offsetWidth)); foreign.setAttribute('height', String(card.offsetHeight));
        const copy = styledClone(card) as HTMLElement;
        copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml'); copy.style.position = 'static';
        foreign.append(copy); output.append(foreign);
    }
    post({ type: 'export', format: 'svg', content: new XMLSerializer().serializeToString(output) });
}
post({ type: 'ready' });
