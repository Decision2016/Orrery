# Orrery · Local AI Agent Observatory

**Orrery（太阳系仪）** 是一个面向 **3840×1100 超宽副屏** 的本地 AI Agent 运行监视台，零侵入只读采集本机运行的 **T3 Code**、**Codex（Desktop App + CLI）** 以及可扩展本地 Agent（Claude Code / OpenCode）实时状态，提供 **GridStack.js 24×10 自由拖拽/缩放驾驶舱** 与 **单程序一体化 Tauri v2 Windows 桌面版**。

## 核心能力

- **零侵入只读采集**：基于 Node 24 内置 `node:sqlite`（`readOnly` + WAL `busy_timeout`）与 Codex `rollout-*.jsonl` 字节偏移增量尾读，不锁库、不干扰 Agent 运行。
- **跨源关联去重 (`T3 → Codex`)**：通过 `nativeThreadRef.nativeId === codex.threads.id`（及 `originator + cwd` 兜底）将 T3 Code 内部拉起的 Codex 会话合并为单条任务，融合两边最全的审批、PR、Subagent 与 Token 遥测。
- **Windows 进程存活校验**：实时采样本地 Agent 进程树（CPU% / 内存 MB / PID），交叉验证僵尸状态。
- **3840×1100 GridStack.js 自由编排**：
  - 48px 单行顶部 HUD + 24 列 × 10 行零垂直主滚动驾驶舱
  - `ResizeObserver` 动态行高，自动适配 100% / 125% / 150% Windows DPI 缩放
  - 内置 3 套预设（「全景驾驶舱」「极简大字守望」「多任务排障」）与 9 个可插拔组件，支持编辑/锁定切换并持久化至 `~/.orrery/layouts.json`
- **双形态运行**：
  - **单程序一体化桌面版（`orrery.exe`）**：前端内嵌 + 后台无黑窗自动托管 Node 采集服务（Windows Job Object 绑定，退出零残留）+ 指定副屏自动吸附（自动匹配 `3840×1100`）+ `WS_EX_TOOLWINDOW` 跨 Windows 多虚拟桌面（`Win+Ctrl+←/→`）固定常驻 + 系统托盘管理 + 原生桌面告警通知。
  - **本地服务 + 浏览器全屏/Kiosk**：`127.0.0.1:4318` 同时支持任意浏览器与 Edge/Chrome `--app` 副屏启动脚本。

## 快速启动

### 方式 1：单程序桌面版（推荐，Phase 3）
```powershell
# 1. 构建前后端与桌面程序
npm install
npm run build
cd src-tauri && cargo build --release

# 2. 直接运行单一桌面程序（自动拉起后台采集并吸附 3840x1100 副屏）
.\src-tauri\target\release\orrery.exe
```

### 方式 2：本地服务 + 浏览器副屏全屏（Phase 1/2）
```powershell
# 一键启动本地服务并在 3840x1100 副屏以无边框 App 模式打开
.\scripts\start-orrery.ps1

# 或强制真全屏 Kiosk 模式
.\scripts\start-orrery.ps1 -Kiosk

# 仅启动后台服务（访问 http://127.0.0.1:4318）
.\scripts\start-orrery.ps1 -NoBrowser
```

## 目录结构

- `packages/shared`：统一遥测数据模型与 GridStack 默认布局预设
- `packages/server`：Node 24 本地采集服务（T3 / Codex / Process / 可扩展插件注册表、去重引擎、REST + SSE API）
- `packages/web`：React 19 + Tailwind CSS v4 + GridStack.js 24×10 超宽副屏控制面板
- `scripts/`：Windows 副屏浏览器 Kiosk 与一键启动脚本
- `src-tauri/`：Tauri v2 单程序桌面外壳（副屏锁定、跨虚拟桌面常驻、托盘菜单、Job Object 托管后端）
- `docs/ARCHITECTURE.md`：完整架构与数据源说明

## 常用命令

```powershell
npm run build      # 构建 shared + server + web
npm test           # 运行全部服务端与适配器测试
npm run typecheck  # 全仓 TypeScript 类型检查
```
