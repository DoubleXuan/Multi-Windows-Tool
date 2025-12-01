**Project**

- **Name**: `Multi-Windows-Tool`
- **Description**: 在独立窗口中显示引用查找和调用层级，改善长行截断与可读性。
- **Version**: `1.0.0`
- **Publisher**: `DoubleX`

**Features**

- **引用查找（独立窗口）**: 在旁侧打开一个独立 Webview 窗口，列出引用并支持一键跳转。
- **调用层级（独立窗口）**: 展示函数/方法的调用入链，支持展开子节点并跳转到定义。
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

- **从命令面板**: 打开命令面板 (Cmd+Shift+P)，输入 `Find References (New Window)` 或 `Show Call Hierarchy (New Window)` 来运行相应命令。
- **从编辑器右键菜单**: 在支持引用/调用层级的编辑器上下文菜单中，也会出现对应的菜单项用于快速打开独立窗口。

**Development Notes**

- **源码入口**: `src/extension.ts` 实现了命令注册、Webview 内容与对 VS Code API 的调用逻辑。
- **编译输出**: 编译后入口为 `out/extension.js`，`package.json` 的 `main` 字段已指向该位置。
- **样式资源**: 扩展内使用资源位于 `media/`，例如 `media/codicon.css` 用于图标与样式支持。

**Localization**

- **默认字符串**: `package.nls.json` 包含可本地化的 UI 文本键与默认值（英语）。
- **中文翻译**: `package.nls.zh-cn.json` 提供中文翻译，已覆盖命令标题等文本。

**Files of Interest**

- **`package.json`**: 扩展元数据、命令与菜单项定义。
- **`src/extension.ts`**: 扩展主要实现。
- **`media/`**: 存放 Webview 静态资源（CSS、icon 等）。

**Troubleshooting**

- **未显示命令**: 请确保已编译并在 `Extension Development Host` 启动扩展，且当前文件类型支持引用/调用层级提供者。
- **Webview 样式异常**: 检查 `media/codicon.css` 的路径是否被正确加载（`localResourceRoots` 配置）。

**License**

- **License**: 请参见仓库根目录的 `LICENSE.md`。

---
