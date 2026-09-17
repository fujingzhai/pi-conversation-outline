# pi-conversation-outline

Fullscreen 对话区右侧的 2 列大纲轨：每轮提问一根刻度，悬停预览，点击跳到原对话。不回退、不分叉、不改上下文。

A Grok Build–style outline rail for [Pi](https://pi.dev): one tick per user prompt, hover preview, click to jump. Read-only.

## 安装

```bash
pi install npm:pi-conversation-outline
```

或：

```bash
pi install git:github.com/youxia-2025/pi-conversation-outline
```

需要 `tuiMode: "fullscreen"`（Pi 当前默认已是）。装完 `/reload` 或新开会话。

## 用法

启动后，终端宽度 ≥ 60 且至少 2 轮提问时，轨会出现在对话区右侧。不必打斜杠命令。

- 每轮提问一根刻度，按对话顺序排（不是滚动比例）
- 当前视口顶部那一轮高亮
- ▲ / ▼ 跳到上一轮 / 下一轮
- 鼠标悬停刻度显示提问预览；点击跳到该条提问
- `Ctrl+Alt+O` 显示 / 隐藏

regular 模式没有应用内鼠标，轨不出现。只读当前根到叶的分支。预览是提问首行，不含工具轨迹 / thinking。

## 限制

本扩展会碰 Pi TUI 的未公开结构（对话 ScrollView、gutter、nonCapturing overlay）。**Pi 大版本更新后可能失效。** 失效时轨消失或跳转不准，卸载即可：

```bash
pi remove npm:pi-conversation-outline
```

若同时装着 Claude Code 风格的工具卡扩展（例如会改 `hasOverlay` / 折叠卡点击的包），本扩展会把 `hasOverlay` 收成「是否有抢输入的 overlay」，并挡住原生单击 toggle，避免和折叠卡抢鼠标。没有这类扩展时，这些补丁是空操作。

## 开发

```bash
npm test
```

本地试跑（不写入 settings）：

```bash
pi -e ./extensions/index.ts
```
