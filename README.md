# 反重力多账号 · Ekko Studio 插件 (agy-accounts)

> 以官方 **Google Antigravity（`agy`）CLI** 为执行引擎的 Ekko Studio 智能体插件。
> 在 Studio 里维护一个本地 Google 账号池：网页内完成 OAuth 导入、验证凭据、切换全局默认账号与默认模型，并自动同步已存在的反重力会话。

[![ci](https://github.com/mafengkai/ekko-plugin-agy-accounts/actions/workflows/ci.yml/badge.svg)](https://github.com/mafengkai/ekko-plugin-agy-accounts/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-1.4.0-blue.svg)](https://github.com/mafengkai/ekko-plugin-agy-accounts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Ekko Studio](https://img.shields.io/badge/Ekko%20Studio-plugin%20api%20v1-6f42c1.svg)](https://github.com/mafengkai/ekko-plugin-agy-accounts)

---

## 前提条件

| 依赖 | 是否必须 | 说明 |
| --- | --- | --- |
| Ekko Studio（支持插件 API v1） | 必须 | 插件运行在 Studio 服务端进程内，安装需要 `super_admin` |
| Google Antigravity CLI（`agy`） | 必须 | 所有推理都走官方 CLI。要求 `agy --version` 可执行；不在 `PATH` 里时用 `AGY_BIN` 指定绝对路径 |
| Python 3（含 `pty` 模块） | 仅「网页内授权」需要 | 无头驱动 `agy` 登录 TUI 用。没有它仍可用「导入服务器上的登录」或「粘贴 token」加账号；可用 `AGY_OAUTH_PYTHON` 指定解释器 |
| Node.js ≥ 20 | 必须 | 插件零 npm 依赖，仅要求宿主 Node 版本 |

平台支持：

| 平台 | 账号池 / 模型 / 会话切换 | 网页内 OAuth 授权 |
| --- | --- | --- |
| Linux、macOS、WSL | ✅ | ✅ |
| Windows 原生 Studio | ✅ | ❌（没有 Unix PTY）→ 用「导入服务器上的登录」或「粘贴 token」 |

插件设置页顶部有 **运行环境** 自检，直接显示 `agy` 版本、Python 驱动与无头授权是否可用，点「重新检测」可刷新。

---

## 安装

### 方式一：Studio 插件中心（推荐）

1. Ekko Studio → 左下角头像 → **设置** → **插件中心** → **安装插件**
2. 来源填入本仓库地址：

```text
https://github.com/mafengkai/ekko-plugin-agy-accounts
```

3. 勾选「我信任此可执行插件」→ 安装。宿主会自动钉到 `main` 的最新 commit。

### 方式二：Studio 管理 API

`<studio-port>` 为 Ekko Studio 服务端口（默认 `6060`），`<jwt>` 为超级管理员访问令牌：

```bash
curl -X POST http://127.0.0.1:<studio-port>/api/studio/plugins/install \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/mafengkai/ekko-plugin-agy-accounts",
    "trusted": true,
    "revision": 0,
    "expectedVersion": "1.4.0"
  }'
```

### 零外部依赖

插件**没有任何 npm 运行时依赖**（插件 SDK 契约内置于 `sdk/harness/contracts.mjs`），
宿主执行 `npm install --ignore-scripts --omit=dev` 时不访问任何 registry，因此 GitHub 地址可直接安装。

---

## 添加账号（三种方式，任选）

1. **网页内 OAuth（最省事）**：设置页 →「获取授权链接」→ 浏览器登录 Google → 复制授权码 →「提交授权码」。凭据自动入库，PKCE 的 `code_verifier` 全程只存在于驱动进程内存。
2. **导入服务器上的登录**：这台机器上已经 `agy` 登录过（`~/.gemini/antigravity-cli/antigravity-oauth-token`）时，点一下就导入成一个账号。
3. **粘贴 token**：把 `antigravity-oauth-token` 文件内容粘进文本框导入，适合跨机器迁移。

导入后对单个账号点「验证」：插件用隔离 `HOME` 跑一次 `agy models`，确认凭据真能用。

---

## 会话内切换

| 命令 | 作用 |
| --- | --- |
| `/agy-accounts:account` | 查看当前会话使用的账号与可用账号 |
| `/agy-accounts:account <id>` | 该会话改用指定账号（`default` 复位为全局默认） |
| `/agy-accounts:model` | 查看当前模型与目录 |
| `/agy-accounts:model <id>` | 该会话改用指定模型（`default` 复位） |

设置页的「默认账号 / 默认模型」是**全局**的：保存默认模型会顺带同步所有存量反重力会话的模型字段。

---

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 自检显示「引擎 agy 未安装」 | `agy` 不在 `PATH` | 安装 Antigravity CLI，或设 `AGY_BIN=/abs/path/agy` 后重启 Studio |
| 点「获取授权链接」提示未找到 Python 3 | 缺 `python3`，或缺 `pty`/`fcntl` | `apt install python3`，或 `AGY_OAUTH_PYTHON=/abs/path/python3`；也可改用导入/粘贴 |
| 提示「Windows 没有 Unix PTY」 | Windows 原生宿主 | 在 WSL 里跑 Studio，或改用导入/粘贴 |
| 授权链接生成超时（20s） | `agy` 升级后 TUI 菜单变化 | 先手动跑 `agy` 看能否弹出登录菜单；失败时用导入/粘贴兜底 |
| 「验证」提示 429 / quota | 该账号配额耗尽 | 换账号或等配额重置；插件不代理、不转卖配额 |

遇到环境类报错，先看设置页「运行环境」那行自检结果，基本能定位。

---

## 隐私与安全

- 凭据只落在插件私有数据目录（宿主 `plugin-data/agy-accounts/accounts/`，权限 `0700`），**不上传、不中继**任何 Google 凭据。
- 每个会话用独立 `HOME`，凭据只写入该 `HOME`；全局 `~/.gemini` 只做配置镜像（symlink），不写穿你自己的登录态。
- 仓库侧：`scripts/check.mjs` 在 CI 里扫令牌、私钥、真实 Gmail 地址，命中即失败。

---

## 开发与测试

```bash
node scripts/check.mjs   # 静态校验：manifest、契约与注册一致性、语法、敏感信息（CI 跑这个）
npm test                 # 桩 ctx 自测：需要本机已装 agy，且最好已登录
```

目录结构：

```text
plugin.json           插件清单（id / version / 权限 / 视图）
contracts/plugin.json RPC、命令、storage 与 checkpoint 的公开数据结构
server.mjs            服务端：账号库、模型目录、OAuth 驱动、agent 运行时
client.mjs            设置页 UI（运行环境自检 / 账号 / 默认模型）
scripts/check.mjs     CI 静态校验
scripts/selftest.mjs  桩 ctx 自测
scripts/oauth_pty.py  无头 agy OAuth 驱动（PTY 注入授权码）
docs/                 宿主契约参考文档
```

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## English summary

An Ekko Studio plugin that turns Google's official Antigravity (`agy`) CLI into a multi-account agent:
a local Google account pool (in-browser OAuth import, token paste, or importing the host's existing `agy`
login), per-account credential verification, global default account/model switching with retroactive
session sync, and in-session switching via `/agy-accounts:account` and `/agy-accounts:model`.

Requirements: Ekko Studio with plugin API v1, the `agy` CLI on `PATH` (or `AGY_BIN`), and Python 3 with
`pty` for the in-browser OAuth helper (token import works without it). Linux/macOS/WSL are fully supported;
native Windows keeps every feature except the headless OAuth helper. Zero npm dependencies — install
straight from this repository URL.

## License

[MIT](LICENSE) © 2026 mafengkai
