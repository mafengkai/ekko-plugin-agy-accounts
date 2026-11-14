# Ekko Studio 插件：反重力多账号 (agy-accounts)

> 以官方 **Google Antigravity (`agy`) CLI** 为执行引擎的 Ekko Studio 智能体插件。
> 支持本地安全维护 Google 账号池，在 Studio 页面内无缝添加账号、验证模型配额、切换全局默认账号与默认模型，并自动同步更新历史会话。

[![Ekko Studio Plugin](https://img.shields.io/badge/Ekko%20Studio-Plugin%20v1-blue.svg)](https://github.com/mafengkai/ekko-plugin-agy-accounts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🌟 核心特性

1. **官方引擎直连**：复用官方 `agy` CLI 二进制与会话机制，保证完整的智能体多轮对话、工具调用与推理能力。
2. **多账号安全池**：
   - 账号凭证只存储在 Studio 插件私有持久化数据目录（`ctx.paths.dataDir`），与插件源码绝对物理隔离。
   - 绝对零凭据外泄，支持一键健康检查（`accounts.verify`）查询可用模型列表（例如 Gemini 3.8 / 4.0 系列）。
3. **网页端 OAuth 闭环**：
   - 无需暴露任何桌面 GUI、无须本地浏览器监听端口。
   - 在 Studio 设置页面中一键生成 Google OAuth 授权链接，在任意浏览器完成登录后，回填授权码即可无感兑换并录入账号池。
4. **全局会话联动**：
   - 支持在设置页面指定全局默认账号。
   - 支持在设置页面保存默认模型，并自动遍历更新当前所有反重力会话的显示与运行参数，解决设置变更后历史会话显示不一致的问题。

---

## 📦 安装与启用

### 方式一：Ekko Studio 插件中心界面安装（推荐）

1. 进入 Ekko Studio，点击左下角头像 -> **设置** -> **插件中心**。
2. 点击右上角 **安装插件**。
3. 在安装来源输入框中填入本仓库地址：
   ```text
   https://github.com/mafengkai/ekko-plugin-agy-accounts
   ```
4. 勾选 **“我信任此可执行插件”**，点击确认安装即可。

### 方式二：通过 Studio API 安装

超级管理员可调用安装端点（`<studio-port>` 为 Ekko Studio 服务端口，默认 `6060`，以实际部署为准）：

```bash
curl -X POST http://127.0.0.1:<studio-port>/api/studio/plugins/install \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/mafengkai/ekko-plugin-agy-accounts",
    "trusted": true,
    "revision": 0,
    "expectedVersion": "1.3.3"
  }'
```

### 零外部依赖

本插件**没有任何 npm 运行时依赖**（插件 SDK 契约已内置在 `sdk/harness/contracts.mjs`），
宿主执行 `npm install --ignore-scripts --omit=dev` 时不需要访问任何私有 registry，
因此可以直接从 GitHub 仓库地址安装。

---

## 🚀 快速上手

1. 安装并启用插件后，在左侧边栏或设置页进入 **反重力账号** 面板。
2. 点击 **“添加账号”**，点击生成授权链接并在浏览器中打开。
3. 登录 Google 账号并完成授权，将页面给出的授权码（Authorization Code）粘贴回 Studio 界面，点击确认。
4. 授权成功后，账号将自动录入账号池并完成模型探测；您可选择将其设为全局默认账号。
5. 在下方模型列表中选择默认模型并点击保存，存量会话将自动同步更新。

---

## 🔒 隐私与安全声明

- **凭证完全本地化**：本插件绝不上传、同步或中继您的 Google 账号密码、Refresh Token 或 OAuth 凭证至任何第三方服务器。
- **开源代码纯净**：开源仓库不包含任何本地账号数据或环境测试密钥。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
