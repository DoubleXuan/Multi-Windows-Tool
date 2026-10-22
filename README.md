# Multi-Windows-Tool

VS Code 中的交互式代码调用关系查看器，提供类似 Source Insight Relation Window 的逐层阅读体验。版本：2.0.1。

```text
调用者                  当前函数                  被调用者
main ────────────────→ processData ─────────────→ validate
                           └───────────────────→ save
```

## 功能

- 双向调用关系：中心函数左侧显示调用者，右侧显示被调用者；箭头始终表示“调用者 → 被调用者”。
- 按需展开：每个分支独立展开、收起，重复展开复用查询缓存；默认每批展示 20 个关系。
- 精确导航：函数名跳转定义；展开“调用位置”后可跳转每个调用点，包括同一行不同列的位置。
- 图形 / 列表同步切换，支持平移、缩放和适应窗口。
- 紧凑显示：图形节点按函数名宽度自适应，默认约 24px 高；列表为 22px 树形行，文件信息按列对齐。
- 节点边缘的 `+ / −` 控制展开，`×N` 查看调用位置；图形中的文件路径在悬停提示中显示，工具栏位于底部。
- 默认锁定根节点，可切换为防抖跟随编辑器光标；从图中导航不会立即换根。
- 浏览前进 / 后退，点击节点的 `◎` 将其设为新中心。
- 搜索已展开函数或文件路径，Enter 定位首个匹配节点。
- 递归检测：同一条路径再次出现相同函数时停止展开；共享函数可分别出现在多个分支。
- 代码修改后提示关系可能过期，并拒绝旧请求的结果；点击刷新重新分析。
- 导出当前可见图为 SVG 或结构化 JSON。SVG 使用 foreignObject 保存节点文字，建议在浏览器中查看。
- VS Code 恢复已有关系面板时，重新查询并恢复匹配的展开路径及视图模式；单独的恢复命令可重新打开上次根符号。
- 保留按文件分组的引用查找，文件分组可折叠，引用可精确跳转。

## 使用

需要 VS Code 1.85 或以上版本，并安装目标语言对应的语言扩展。

1. 将光标放在函数名上。
2. 右键选择“显示调用层级结构 (独立窗口)”，或从命令面板执行“打开调用关系查看器”。
3. 点击“调用者 / 被调用者”展开分支；分支内继续沿原方向探索，反向查看可先将节点设为中心。
4. 点击“已锁定”切换为跟随光标。点击“当前符号”手动切换根节点。

“独立窗口”是 VS Code 内部的 Webview 编辑器面板，可以拖动到需要的位置。重复执行打开命令可创建多个面板。

| 命令 | 作用 |
| --- | --- |
| `multiRef.open` | 打开调用关系查看器 |
| `multiRef.callHierarchy` | 从光标符号打开查看器，兼容原有命令 |
| `multiRef.restore` | 恢复工作区中上次浏览的根符号和跟随模式 |
| `multiRef.find` | 按文件分组查找引用 |

配置项：

```json
{
  "multiRef.followEditor": false,
  "multiRef.followDelay": 350
}
```

跟随模式在每个面板内独立切换，配置项用于新面板的默认值。跟随延迟范围为 150–2000 毫秒。

## 分析能力与边界

扩展复用 VS Code 语言服务的 `prepareCallHierarchy`、`provideIncomingCalls`、`provideOutgoingCalls` 和引用查询，不自行扫描或解析源码。支持范围和准确性由语言服务决定；没有查询结果不等同于程序绝对不存在调用。

C/C++ 工程需正确配置 clangd 或所用 C/C++ 语言扩展，包括编译参数、头文件和宏；建议使用工程生成的 `compile_commands.json`。函数指针、虚调用、宏与条件编译的覆盖范围需要在真实项目中检查。本版本没有自建全工程语义索引，也不推断运行时调用链。

节点采用“路径展示”而非全局合并，相同函数可出现在多个分支。每批显示 20 个关系，接近 400 个可见节点时限制继续展开；可收起分支或重新设中心继续探索。JSON 导出当前可见关系，不代表完整项目索引。

文件编辑、创建、删除和重命名会使缓存失效。外部依赖或语言服务的索引状态发生变化后，也可手动刷新。恢复会话时按原 URI 和位置重新解析；大幅修改源码后可能需要重新选择根符号。

## 开发与验证

```sh
npm ci
npm run compile
npm run watch
```

编译会检查扩展和 Webview 的 TypeScript，将前端打包到 `out/webview/`，并复制 ELK 浏览器包及许可证。运行时不加载 CDN 或在线资源。

在 VS Code 中按 F5 启动 Extension Development Host。可使用仓库附带的 `.vscode/launch.json` 和编译任务。打开 `test/fixtures/calls.ts`，在 `processData`、`recursive`、`One.same`、`Two.same` 上验证真实 TypeScript 语言服务。

```sh
npm run test:unit
npx playwright install chromium
npm test
```

Linux 环境若缺少浏览器系统库，可运行 `npx playwright install --with-deps chromium`。如使用自定义浏览器缓存路径，安装和测试需设置相同的 `PLAYWRIGHT_BROWSERS_PATH`。

自动测试包括：

- 数据模型：双向展开、共享符号、递归、失败重试、过期结果、缓存和分页。
- 语言服务适配：保留原始 provider 对象、调用点去重、同名符号区分、outgoing 调用点归属调用者文件。
- 扩展宿主模拟：编辑后失效、异步解析顺序、浏览历史及跟随导航抑制。
- Chromium：加载实际 Webview HTML 与 CSP，使用真实 ELK 布局检查左右关系、跳转、折叠、列表同步、特殊字符、导出和会话恢复。

浏览器和宿主模拟测试不替代真实 VS Code 语言扩展的集成验证。发布前请按上述样例进行人工检查，并在目标 C/C++ 工程确认索引结果。

## 代码结构

```text
src/
  extension.ts    命令、生命周期及面板恢复注册
  controller.ts   面板会话、历史、跟随、请求版本及导出
  provider.ts     VS Code 语言服务适配、符号身份和查询缓存
  graph.ts        路径展开模型、递归检测和分批可见性
  protocol.ts     扩展与 Webview 共享的数据类型
  references.ts   引用查找
  webview.ts      Webview 安全外壳和代码导航
webview/
  app.ts          HTML 节点、SVG 连线、ELK 布局与交互
  app.css         VS Code 主题适配
scripts/          编译与开发监听
test/             单元测试、浏览器测试与语言服务样例
```

使用 MIT 许可证。ELK.js 等第三方资源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
