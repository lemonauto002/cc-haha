# 从本地源码编译并运行 cc-haha 桌面端

> 本文档讲如何在本机（**macOS** 或 **Ubuntu**）从源码把 cc-haha 桌面端跑起来（开发模式 / 打包正式版）。
> 仓库活跃壳是 **Electron**；`src-tauri` 为遗留资源，本文不涉及。

---

## 0. 你会得到什么

- 一个跑在本机的 cc-haha 桌面应用（开发模式带热更新），身份是 `claude-code-desktop`，与已安装的正式版 `Claude Code Haha` **数据相互隔离**，可并存。
- 要聊天/用语音，桌面端需要一个本地 server 二进制（sidecar），首次必须自行构建（见第 5 步）。

---

## 1. 前置条件

### 通用
- **Git**。
- **Node.js ≥ 20**（推荐 22；脚本里直接调 `node ./node_modules/typescript/bin/tsc`）。
- **Bun**（构建工具链必需：`bun install` / `bun build` / `bun run`）。安装见第 3 步。

### macOS
```bash
# Xcode 命令行工具（编译 node-pty 等原生模块需要）
xcode-select --install
# Homebrew（若未安装）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Ubuntu / Debian
```bash
sudo apt update
sudo apt install -y build-essential python3 git ca-certificates
# Electron 运行时依赖（GUI + 音频）
sudo apt install -y \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
  libatspi2.0-0 libdrm2 libgbm1 libxcb1 libasound2
# 注意：Ubuntu 24.04 上 libasound2 可能叫 libasound2t64，装其中一个即可
```

---

## 2. 获取源码

```bash
git clone https://github.com/<你的fork或NanmiCoder>/cc-haha.git
cd cc-haha
```

---

## 3. 安装 Bun

**macOS（Homebrew）：**
```bash
brew install oven-sh/bun/bun
```

**Ubuntu / 任意 Linux（官方脚本）：**
```bash
curl -fsSL https://bun.sh/install | bash
# 按提示把 bun 加入 PATH（通常加到 ~/.bashrc 或 ~/.zshrc）
exec $SHELL
```

验证：`bun --version`

---

## 4. 安装依赖（三处都要装）

cc-haha 是 monorepo 风格，**三个目录各自有 `package.json`**，开发模式需要全部装好：

| 目录 | 作用 | 为什么需要 |
|---|---|---|
| `desktop/` | 桌面端（Electron + React） | 渲染层 + 主进程 |
| `.`（根） | CLI / 本地 server 源码 | 第 5 步构建 sidecar 时会 bundle 这部分 |
| `adapters/` | IM 适配器（TG/飞书/微信/钉钉…） | sidecar 会 bundle 适配器代码，缺了 `build:sidecars` 会报缺包 |

```bash
# 桌面端
cd desktop && bun install && cd ..

# 根（CLI/server）
bun install

# IM 适配器
cd adapters && bun install && cd ..
```

> ⚠️ 只装 `desktop/` 会在后面 `build:sidecars` 报 `Could not resolve: lodash-es / axios / @anthropic-ai/sdk / grammy …`——那就是根或 adapters 的依赖没装。

---

## 5. 首次：下载 Electron 二进制

`bun install` 不一定会触发 Electron 的二进制下载。首次手动跑一次安装脚本：

```bash
cd desktop
node ./node_modules/electron/install.js
# 验证：应能看到 node_modules/electron/dist/Electron.app（mac）或 electron（linux）
ls node_modules/electron/dist
```

### 🀄 国内网络：用镜像（强烈建议）
`@electron/get` 走的是 Node 全局 `fetch`，**不读 `https_proxy` 环境变量**，直连 GitHub 容易失败。用国内镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node ./node_modules/electron/install.js
```

依赖安装也可以挂代理加速（bun 读 `HTTPS_PROXY`）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 bun install
```

---

## 6. 首次：构建 server sidecar

桌面端启动时要拉起一个本地 server（聊天/会话都靠它）。这个 server 是把根目录的 CLI/server 源码编译成的**单文件二进制**，首次必须构建：

```bash
cd desktop
bun run build:sidecars
```

成功后产物在 `desktop/src-tauri/binaries/claude-sidecar-<triple>`（macOS 自动 ad-hoc 签名；Linux 无需签名）。
- `triple` 由脚本自动探测：macOS arm64 → `aarch64-apple-darwin`；Ubuntu x64 → `x86_64-unknown-linux-gnu`；etc.

> ⚠️ 不做这步直接 `electron:dev`，窗口会弹「本地服务启动失败：sidecar binary not found」。
> 改了根目录或 adapters 的 server 代码后，需要重新 `build:sidecars`。

---

## 7. 启动开发模式（带热更新）

```bash
cd desktop
bun run electron:dev
```

这条命令会：构建 electron 主进程（`build:electron`）→ 启动 Vite 渲染层（`http://localhost:1420`）→ 拉起 Electron 窗口 → 启动 sidecar server。

- 改 **渲染层代码**（`desktop/src/**/*.tsx|ts`）：Vite 自动热更新，无需重启。
- 改 **electron 主进程**（`desktop/electron/**`）：会自动重新 bundle；必要时重启 `electron:dev`。
- 关闭窗口即退出；`Ctrl+C` 停止。

**首次使用语音功能**：macOS 会弹麦克风授权，点允许（开发版身份独立，不影响正式版）。

---

## 8. 打包正式版（可选）

```bash
cd desktop
bun run electron:package        # 产出可安装包（dmg/nsis/AppImage）
# 或只打当前平台的解包目录（更快，用于本地验证）：
bun run electron:package:dir
```

产物在 `desktop/build-artifacts/electron/`。跨平台打包请用各自的 CI 脚本（`scripts/build-macos-arm64.sh` / `build-linux.sh` / `build-windows-x64.ps1`）。

---

## 9. 常用命令速查（均在 `desktop/` 下执行）

| 命令 | 作用 |
|---|---|
| `bun run electron:dev` | 开发模式（推荐日常用） |
| `bun run dev` | 只起 Vite 渲染层（浏览器里看 UI，无 electron 主进程） |
| `bun run build` | 渲染层类型检查 + 生产 web 构建 |
| `bun run build:electron` | 重新 bundle electron 主进程（main/preload/preview-preload） |
| `bun run build:sidecars` | 构建 server/cli sidecar 二进制 |
| `bun run electron:build` | sidecars + build + build:electron（一次到位的生产构建） |
| `bun run electron:package` | 打包成可安装应用 |
| `bun run lint` | 渲染层 `tsc --noEmit`（严格模式） |
| `bun run check:electron` | electron 侧 `tsc` + 测试 + bundle |
| `bun run test` | 跑 Vitest（含桌面端单测） |

---

## 10. 排错（实战踩坑）

| 现象 | 原因 / 解决 |
|---|---|
| `Could not resolve: lodash-es / axios / grammy …` 跑 `build:sidecars` 时 | 根目录或 `adapters/` 没装依赖 → 回到第 4 步把三处都 `bun install` |
| 启动弹「sidecar binary not found」 | 没构建 sidecar → 第 6 步 `bun run build:sidecars` |
| `Electron failed to install correctly` / `fetch failed` | Electron 二进制没下下来 → 第 5 步用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重装 |
| `bun install` 卡住/超时 | 网络 → 挂代理 `HTTPS_PROXY=http://127.0.0.1:<port> bun install` |
| macOS 编译 node-pty 报错 | 缺 Xcode CLT → `xcode-select --install` |
| Ubuntu 上 Electron 窗口起不来/黑屏 | 缺运行时库 → 第 1 步那一串 `apt install`；Wayland 下可试 `electron:dev` 前加 `--ozone-platform=wayland` 或切 X11 |
| dev 窗口看不到 / 被正式版窗口挡住 | Dock 上找 **Electron 图标**（开发版是通用原子图标，非 cc-haha 图标）；或 ⌘Tab 找 "Electron" |
| 语音「测试语音」报 no supported source | CSP 拦了 blob 音频（已在 `desktop/index.html` 加 `media-src 'self' blob: data:`）；确认 dev 已加载最新 `index.html` |

---

## 11. 语音功能快速开始（开发版）

1. 应用启动后：**设置 → 语音**
2. 填 **火山 API Key**（资源 ID、音色已预填默认值），保存，点「测试语音」应能听到播报。
3. 打开「启用语音输入」→ 回到聊天框出现 🎤 麦克风按钮。
4. 点 🎤 点亮（变蓝 = 语音模式）→ **按空格**开始录音（升调提示音）→ **再按空格**停止（降调提示音）→ 识别文字进输入框或自动发送。麦克风保持常开，可连续按空格说。
5. （可选）打开「朗读回复」→ Claude 回复后自动播报（代码块会剔除）。

> 端到端验证协议可跑：`cd desktop && bun run scripts/test-volcano.ts`（需已填好火山 Key 且本机有 ffmpeg）。

---

## 附：远程仓库（如需推送自己的 fork）

```bash
git remote add fork https://github.com/<你的用户名>/cc-haha.git
git push -u fork <分支名>
```
