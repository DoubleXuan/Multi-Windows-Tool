const { test, expect } = require('@playwright/test');
const symbol = (id, name = id) => ({ id, name, detail: `${id}.cpp`, uri: `file:///${id}.cpp`, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } });
const relation = (id, direction = 'incoming', name = id) => ({ symbol: symbol(id, name), callerId: direction === 'incoming' ? id : 'root', calleeId: direction === 'incoming' ? 'root' : id,
    sites: [4, 8].map(line => ({ uri: direction === 'outgoing' ? 'file:///root.cpp' : `file:///${id}.cpp`, range: { start: { line, character: 2 }, end: { line, character: 5 } } })) });
const send = (page, data) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
async function root(page, generation = 1, name = 'root') {
    await send(page, { type: 'root', generation, symbol: symbol('root', name), follow: false, canBack: false, canForward: false });
    await expect.poll(() => page.evaluate(g => window.sent.filter(m => m.type === 'expand' && m.generation === g).length, generation)).toBe(2);
}
async function reply(page, direction, relations, occurrenceId = 'root', generation = 1) {
    const request = await page.evaluate(({ direction, occurrenceId, generation }) => window.sent.filter(m => m.type === 'expand' && m.direction === direction && m.occurrenceId === occurrenceId && m.generation === generation).at(-1), { direction, occurrenceId, generation });
    expect(request).toBeTruthy();
    await send(page, { ...request, type: 'children', relations });
}
test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.sent = [];
        window.acquireVsCodeApi = () => ({
            postMessage: message => window.sent.push(message),
            getState: () => JSON.parse(sessionStorage.getItem('viewState') || 'null'),
            setState: state => sessionStorage.setItem('viewState', JSON.stringify(state))
        });
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.sent.some(m => m.type === 'ready'))).toBe(true);
    page.testErrors = errors;
});
test.afterEach(async ({ page }) => { expect(page.testErrors).toEqual([]); });

test('real CSP permits ELK layout; callers appear left, callees right, all links navigate exact locations', async ({ page }) => {
    await root(page);
    await reply(page, 'incoming', [relation('caller')]);
    await reply(page, 'outgoing', [relation('callee', 'outgoing')]);
    await expect(page.locator('.card')).toHaveCount(3);
    await expect(page.locator('svg .edge')).toHaveCount(2);
    const positions = await page.locator('.card').evaluateAll(cards => Object.fromEntries(cards.map(card => [card.dataset.id, parseFloat(card.style.left)])));
    expect(positions['root/incoming/0']).toBeLessThan(positions.root);
    expect(positions['root/outgoing/0']).toBeGreaterThan(positions.root);
    const caller = page.locator('.card[data-id="root/incoming/0"]');
    await caller.getByRole('button', { name: 'caller', exact: true }).click();
    expect(await page.evaluate(() => window.sent.at(-1))).toMatchObject({ type: 'open', location: { uri: 'file:///caller.cpp', range: { start: { line: 2 } } } });
    await caller.locator('summary').click();
    await caller.getByRole('button', { name: 'caller.cpp:9:3', exact: true }).click();
    expect(await page.evaluate(() => window.sent.at(-1))).toMatchObject({ type: 'open', location: { uri: 'file:///caller.cpp', range: { start: { line: 8 } } } });
    const callee = page.locator('.card[data-id="root/outgoing/0"]');
    await callee.locator('summary').click();
    await callee.getByRole('button', { name: 'root.cpp:5:3', exact: true }).click();
    expect(await page.evaluate(() => window.sent.at(-1))).toMatchObject({ type: 'open', location: { uri: 'file:///root.cpp', range: { start: { line: 4 } } } });
    await expect(page.locator('.status')).toBeHidden();
});

test('collapse removes visible edges and re-expansion uses cached children; lists remain synchronized', async ({ page }) => {
    await root(page); await reply(page, 'incoming', [relation('caller')]); await reply(page, 'outgoing', []);
    await expect(page.locator('svg .edge')).toHaveCount(1);
    const before = await page.evaluate(() => window.sent.filter(m => m.type === 'expand').length);
    const rootCard = page.locator('.card[data-id="root"]');
    await rootCard.getByRole('button', { name: '− 调用者 (1)', exact: true }).click();
    await expect(page.locator('svg .edge')).toHaveCount(0);
    await rootCard.getByRole('button', { name: '+ 调用者 (1)', exact: true }).click();
    await expect(page.locator('svg .edge')).toHaveCount(1);
    expect(await page.evaluate(() => window.sent.filter(m => m.type === 'expand').length)).toBe(before);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await expect(page.locator('.tree-card')).toHaveCount(2);
    await page.locator('.tree-card[data-id="root/incoming/0"]').getByRole('button', { name: '+ 调用者', exact: true }).click();
    await reply(page, 'incoming', [relation('grandparent')], 'root/incoming/0');
    await page.getByRole('button', { name: '关系图', exact: true }).click();
    await expect(page.locator('.card')).toHaveCount(3); await expect(page.locator('svg .edge')).toHaveCount(2);
    const height = await page.locator('.card[data-id="root/incoming/0/incoming/0"]').evaluate(card => card.offsetHeight);
    expect(height).toBeGreaterThanOrEqual(20);
    expect(height).toBeLessThanOrEqual(26);
});

test('recursion stops expansion, obsolete generations are ignored, and errors offer retry', async ({ page }) => {
    await root(page);
    await reply(page, 'incoming', [relation('root')]); await reply(page, 'outgoing', []);
    const recursive = page.locator('.card[data-id="root/incoming/0"]');
    await expect(recursive).toContainText('递归'); await expect(recursive.locator('.node-controls')).toHaveCount(0);
    const old = await page.evaluate(() => window.sent.find(m => m.type === 'expand' && m.direction === 'incoming'));
    await root(page, 2);
    await send(page, { ...old, type: 'children', relations: [relation('obsolete')] });
    await expect(page.locator('.card')).toHaveCount(1);
    const request = await page.evaluate(() => window.sent.filter(m => m.type === 'expand' && m.generation === 2 && m.direction === 'incoming').at(-1));
    await send(page, { ...request, type: 'queryError', message: '服务暂不可用' });
    await page.locator('.card[data-id="root"]').getByRole('button', { name: '调用者 重试', exact: true }).click();
    await reply(page, 'incoming', [relation('retried')], 'root', 2);
    await reply(page, 'outgoing', [], 'root', 2);
    await expect(page.locator('.card')).toHaveCount(2);
    await send(page, { type: 'invalidate', generation: 3 });
    await expect(page.locator('.card[data-id="root"] .node-controls button').first()).toBeDisabled();
});

test('special characters render as text, search highlights, re-center and follow send typed messages', async ({ page }) => {
    const name = 'root<"&><img src=x onerror=alert(1)>';
    await root(page, 1, name); await reply(page, 'incoming', [relation('caller')]); await reply(page, 'outgoing', []);
    await expect(page.locator('.card[data-id="root"] .symbol')).toHaveText(name);
    await expect(page.locator('img')).toHaveCount(0);
    await page.getByRole('searchbox').fill('caller');
    await expect(page.locator('.card.match')).toHaveCount(1);
    await page.locator('.card[data-id="root/incoming/0"] .reroot').click();
    expect(await page.evaluate(() => window.sent.at(-1))).toMatchObject({ type: 'reroot', symbolId: 'caller', generation: 1 });
    await page.getByRole('button', { name: '已锁定', exact: true }).click();
    expect(await page.evaluate(() => window.sent.at(-1))).toEqual({ type: 'follow', value: true });
});

test('reference groups really collapse and retain precise navigation', async ({ page }) => {
    const target = { uri: 'file:///a.cpp', range: { start: { line: 8, character: 2 }, end: { line: 8, character: 5 } } };
    await send(page, { type: 'references', title: '引用: foo', groups: [{ path: 'a.cpp', items: [{ ...target, text: 'foo("<tag>")' }] }] });
    await expect(page.locator('.reference')).toBeVisible();
    await page.locator('.reference-file summary').click(); await expect(page.locator('.reference')).toBeHidden();
    await page.locator('.reference-file summary').click(); await page.locator('.reference').click();
    expect(await page.evaluate(() => window.sent.at(-1))).toEqual({ type: 'open', location: target });
});

test('JSON and standalone SVG exports include symbols, real call direction and readable node content', async ({ page }) => {
    await root(page); await reply(page, 'incoming', [relation('caller')]); await reply(page, 'outgoing', []);
    await expect(page.locator('svg .edge')).toHaveCount(1);
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const json = JSON.parse(await page.evaluate(() => window.sent.at(-1).content));
    expect(json.root).toBe('root'); expect(json.symbols).toHaveLength(2);
    expect(json.relations[0]).toMatchObject({ callerId: 'caller', calleeId: 'root' });
    await page.getByRole('button', { name: 'SVG', exact: true }).click();
    const svg = await page.evaluate(() => window.sent.at(-1));
    expect(svg.format).toBe('svg');
    const parsed = await page.evaluate(content => {
        const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
        return { errors: doc.querySelectorAll('parsererror').length, nodes: doc.querySelectorAll('foreignObject').length, text: doc.documentElement.textContent };
    }, svg.content);
    expect(parsed.errors).toBe(0); expect(parsed.nodes).toBe(2); expect(parsed.text).toContain('caller');
});

test('webview recreation restores the view and expanded paths after fresh provider queries', async ({ page }) => {
    await root(page); await reply(page, 'incoming', [relation('caller')]); await reply(page, 'outgoing', []);
    await page.locator('.card[data-id="root/incoming/0"]').getByRole('button', { name: '+ 调用者', exact: true }).click();
    await reply(page, 'incoming', [relation('grandparent')], 'root/incoming/0');
    await expect(page.locator('.card')).toHaveCount(3);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.reload();
    await root(page, 5);
    await reply(page, 'incoming', [relation('caller')], 'root', 5); await reply(page, 'outgoing', [], 'root', 5);
    await expect.poll(() => page.evaluate(() => window.sent.some(m => m.type === 'expand' && m.occurrenceId === 'root/incoming/0'))).toBe(true);
    await reply(page, 'incoming', [relation('grandparent')], 'root/incoming/0', 5);
    await expect(page.locator('.tree')).toBeVisible(); await expect(page.locator('.tree-card')).toHaveCount(3);
});

test('expansion preserves the clicked node position and paginates a high-degree branch', async ({ page }) => {
    await root(page); await reply(page, 'incoming', [relation('caller')]); await reply(page, 'outgoing', []);
    await expect(page.locator('svg .edge')).toHaveCount(1);
    const card = page.locator('.card[data-id="root/incoming/0"]');
    const before = await card.boundingBox();
    await card.getByRole('button', { name: '+ 调用者', exact: true }).click();
    await reply(page, 'incoming', Array.from({ length: 25 }, (_, i) => relation(`parent-${i}`)), 'root/incoming/0');
    await expect(page.locator('svg .edge')).toHaveCount(21);
    const after = await card.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    await page.getByRole('button', { name: '列表', exact: true }).click();
    await page.locator('.tree-card[data-id="root/incoming/0"]').getByRole('button', { name: '再显示 5 个调用者', exact: true }).click();
    await expect(page.locator('.tree-card')).toHaveCount(27);
});

test('Source Insight style nodes fit their text and outline rows stay compact with aligned file columns', async ({ page }) => {
    await root(page);
    await reply(page, 'incoming', [relation('caller'), relation('long', 'incoming', 'a_very_long_function_name_'.repeat(12))]);
    await reply(page, 'outgoing', [relation('callee', 'outgoing')]);
    await expect(page.locator('svg .edge')).toHaveCount(3);
    const short = await page.locator('.card[data-id="root/incoming/0"]').boundingBox();
    const long = await page.locator('.card[data-id="root/incoming/1"]').boundingBox();
    expect(short.height).toBeLessThanOrEqual(26); expect(short.width).toBeLessThan(180);
    expect(long.width).toBeGreaterThan(short.width); expect(long.width).toBeLessThanOrEqual(350);
    expect(long.height).toBeLessThanOrEqual(26);
    const card = page.locator('.card[data-id="root/incoming/0"]');
    await expect(card.locator('.detail')).toBeHidden();
    await card.locator('summary').click();
    await expect(card.getByRole('button', { name: 'caller.cpp:9:3', exact: true })).toBeVisible();
    await card.locator('summary').click();
    await page.getByRole('button', { name: '列表', exact: true }).click();
    const dimensions = await page.locator('.tree-card').evaluateAll(rows => rows.map(row => ({ height: row.getBoundingClientRect().height, fileX: row.querySelector('.detail').getBoundingClientRect().left, border: getComputedStyle(row).borderTopWidth })));
    dimensions.forEach(row => { expect(row.height).toBe(22); expect(row.border).toBe('0px'); expect(row.fileX).toBe(dimensions[0].fileX); });
    const outlineCaller = page.locator('.tree-card[data-id="root/incoming/0"]');
    await outlineCaller.locator('summary').click();
    const site = await outlineCaller.getByRole('button', { name: 'caller.cpp:9:3', exact: true }).boundingBox();
    const following = await page.locator('.tree-card[data-id="root/incoming/1"]').boundingBox();
    expect(following.y).toBeGreaterThanOrEqual(site.y + site.height);
    await page.screenshot({ path: 'test-results/compact-outline.png' });
    await page.getByRole('button', { name: '关系图', exact: true }).click();
    await page.getByRole('button', { name: '适应窗口', exact: true }).click();
    await page.screenshot({ path: 'test-results/compact-graph.png' });
});
