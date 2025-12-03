**Project**

- **Name**: `Multi-Windows-Tool`
- **Description**: 在独立窗口中显示引用查找和调用层级，支持树形视图和图形化展示。
- **Version**: `1.1.0`
- **Publisher**: `DoubleX`
- **Repository**: https://github.com/DoubleXuan/multi-windows-tool

**Features**

- **引用查找（独立窗口）**: 在旁侧打开独立 Webview 窗口，按文件分组显示所有引用，支持一键跳转到代码位置。
- **调用层级（独立窗口）**: 展示函数/方法的调用入链，支持展开子节点并跳转到定义。
  - **树形视图**: 分层展示调用关系，清晰查看调用链。
  - **新增：关系图视图**: 使用 vis-network 库提供图形化展示，支持交互式探索调用关系。
  - **智能行号标注**: 图中显示多次调用情况下的所有调用行号。
- **双视图切换**: 工具栏内可快速切换树形列表与关系图两种查看模式。
- **UI 优化**: 针对长行使用 flex + ellipsis 优化显示，保留语法与图标样式。

**Commands**

- **`multiRef.find`**: 查找引用并在侧边独立窗口显示（标题: `查找所有引用 (独立窗口)`）。
- **`multiRef.callHierarchy`**: 显示调用层级并在侧边独立窗口显示（标题: `显示调用层级结构 (独立窗口)`）。

**Quick Start**

- **安装依赖**: 在扩展根目录运行:
```
npm install
```
- **编译 TypeScript**:
```
npm run compile
```
- **开发调试**: 在 VS Code 中按 `F5` 启动 Extension Development Host 进行调试。
- **热编译**: 开发时可使用:
```
npm run watch
```

**How To Use**

- **从命令面板**: 打开命令面板 (Cmd+Shift+P / Ctrl+Shift+P)，输入 `Find References (New Window)` 或 `Show Call Hierarchy (New Window)` 运行。
- **从编辑器右键菜单**: 在支持引用/调用层级的编辑器上下文菜单中，可快速打开独立窗口。
- **查看模式切换**:
  - **调用层级**: 点击工具栏的 **树形** 或 **关系图** 按钮切换展示模式。
  - **引用查找**: 仅提供树形列表视图（关系图按钮隐藏）。
- **图中导航**: 在关系图视图中，点击节点会跳转到对应代码；点击节点右侧的 `[+]` 展开下层调用者。

**Development Notes**

- **源码入口**: `src/extension.ts` 实现命令注册、Webview 内容与 VS Code API 调用逻辑。
- **编译输出**: 编译后入口为 `out/extension.js`，`package.json` 的 `main` 字段已指向该位置。
- **样式资源**: 扩展使用资源位于 `media/`，包括：
  - `media/codicon.css`: 图标与基础样式
  - `media/vis-network.min.js`: 关系图渲染库
- **关键实现**:
  - `getHtmlShell()`: 生成 Webview 容器，包含工具栏与双视图切换。
  - `handleFindReferences()`: 处理引用查找，展示为树形列表。
  - `handleCallHierarchy()`: 处理调用层级，支持树形视图和图形化视图。
  - `vis.Network`: 用于绘制交互式调用关系图。

**Localization**

- **默认字符串**: `package.nls.json` 包含可本地化的 UI 文本键与默认值（英语）。
- **中文翻译**: `package.nls.zh-cn.json` 提供中文翻译，已覆盖命令标题等文本。

**Files of Interest**

- **`package.json`**: 扩展元数据、命令与菜单项定义。
- **`src/extension.ts`**: 扩展主要实现。
- **`media/`**: 存放 Webview 静态资源（CSS、icon 等）。

**Troubleshooting**

- **未显示命令**: 请确保已编译并在 `Extension Development Host` 启动扩展，且当前文件类型支持引用/调用层级提供者。
- **Webview 样式异常**: 检查 `media/` 路径下文件是否完整，`localResourceRoots` 配置是否正确。
- **关系图不显示**: 确保 `media/vis-network.min.js` 已加载；检查浏览器控制台（F12 > Console）是否有报错。
- **点击图中节点无响应**: 确认节点是否处于可交互状态，或尝试刷新窗口 (Ctrl+R)。

**License**

- **License**: 请参见仓库根目录的 `LICENSE.md`。

---

## 更新日志

### v1.1.0 (最新)
- **新增**: 调用层级支持关系图可视化视图（使用 vis-network）
- **新增**: 工具栏支持树形 ⇄ 关系图快速切换
- **新增**: 关系图中显示多次调用情况的所有行号
- **改进**: 优化节点点击逻辑，区分展开与跳转操作
- **改进**: 增强图形化交互体验（拖拽、缩放、导航）

### v1.0.0
- 初始版本：支持引用查找和调用层级的独立窗口展示
