# 变更记录

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。安装源固定到 commit，升级请在插件中心按仓库地址重装（或等宿主提示更新）。

## 1.4.1 — 应用图标

### 新增
- 插件图标 `icon.png`（512×512 PNG，紫粉渐变底 + 上向箭头与倾斜轨道环），供插件中心、市场目录与设置导航展示。宿主会把相对路径读成 base64 data URL 注入 manifest，图标体积 33.6 KB，未超宿主的 256 KB 上限。

### 工程
- `scripts/check.mjs` 增加图标断言：路径合法、文件存在、体积上限、PNG 文件头校验、必须被 `package.json files` 白名单收录。
- 不再保留「禁止顶层 icon」的旧断言（该限制只针对命名图标，捆绑图片路径是合法的）。
- 图标由 `scripts/make-icon.py` 生成（纯标准库、无外部依赖），`python3 scripts/make-icon.py icon.png 512` 可逐字节复现。

## 1.4.0 — 面向公开分发

### 修复
- **缺 Python 3 时不再拖垮宿主进程**：`spawn('python3')` 的 `error` 事件此前无人监听，`ENOENT` 会以未处理事件抛出并终止整个 Studio 服务端进程。现在提前探测解释器、挂载 `error` 监听，并在失败时返回可读指引。
- **缺 `agy` 时不再空等 20 秒**：改为先跑 `agy --version` 预检，缺失时立即返回安装指引，而不是 20 秒后只说「请重试」。
- **Windows 原生宿主明确降级**：无 Unix PTY 时直接说明不可用，并指向「导入服务器上的登录」「粘贴 token」两条替代路径。

### 新增
- `engine.status` RPC：一次性回报 `agy` 版本与路径、Python 驱动（含 `pty` 模块可用性）、平台与无头授权可用性。
- 设置页顶部「运行环境」自检区，含「重新检测」按钮；无头授权不可用时会直接禁用「获取授权链接」，避免无意义点击。
- 环境变量：`AGY_OAUTH_PYTHON` 指定授权驱动解释器（`AGY_BIN` 此前已有）。
- `scripts/check.mjs` 静态校验 + GitHub Actions CI：manifest 字段、契约与注册一致性、语法、敏感信息扫描，外加 `npm pack` 安装冒烟。
- README 补齐前提条件、平台支持矩阵、三种加账号方式与故障排查表；新增英文摘要。
- 自测扩展到 21 项，覆盖「缺 Python 不崩溃」「缺 agy 有指引」两条回归。

## 1.3.3 — 首个公开版本

- 账号池：OAuth 网页内导入、粘贴 token、从服务器全局登录导入，单账号凭据验证。
- 模型目录来自 `agy models`，不硬编码；默认账号 / 默认模型全局生效，保存默认模型同步存量会话。
- 会话内 `/agy-accounts:account`、`/agy-accounts:model` 切换，跨家族换模型或换账号会重置原生上下文。
- 零 npm 依赖，可直接从 GitHub 仓库地址安装。
