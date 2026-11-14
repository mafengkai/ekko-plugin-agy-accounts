/**
 * 反重力多账号插件 —— 服务端。
 *
 * 设计要点：
 * - 引擎永远是官方 agy CLI，不逆向任何内部接口。
 * - 账号隔离只靠 HOME：每个原生会话一个 HOME，`$HOME/.gemini/antigravity-cli/antigravity-oauth-token`
 *   写入该会话选中的账号凭据；全局 `~/.gemini` 只作为配置镜像（symbolic link），绝不写穿。
 * - 模型目录直接来自 `agy models`，不硬编码。
 * - 会话级切换走聊天命令（/agy-accounts:account、/agy-accounts:model），状态存在 state.session。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { assertContracts, registerRpc, validateModel } from './sdk/harness/contracts.mjs'

const contract = assertContracts(JSON.parse(readFileSync(new URL('./contracts/plugin.json', import.meta.url), 'utf8')))

const TOKEN_FILE = 'antigravity-oauth-token'
const KEEP_REAL = new Set([TOKEN_FILE, 'settings.json', 'mcp_config.json', 'AGENTS.md', 'skills', 'conversations', 'conversation_summaries.db'])

function agyBin() {
  return process.env.AGY_BIN?.trim() || 'agy'
}

function globalGeminiHome() {
  const custom = process.env.AGY_GLOBAL_HOME?.trim()
  if (custom) return custom
  return path.join(os.homedir(), '.gemini')
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    const timer = opts.timeout ? setTimeout(() => child.kill('SIGKILL'), opts.timeout) : null
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }) })
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }) })
  })
}

class Accounts {
  constructor(dir) {
    this.dir = path.join(dir, 'accounts')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }
  static validId(id) {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)
  }
  ids() {
    try {
      return fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && Accounts.validId(d.name)).map((d) => d.name).sort()
    } catch { return [] }
  }
  meta(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'meta.json'), 'utf8')) } catch { return {} }
  }
  tokenPath(id) { return path.join(this.dir, id, TOKEN_FILE) }
  readToken(id) {
    try { return fs.readFileSync(this.tokenPath(id), 'utf8') } catch { return '' }
  }
  has(id) { return this.ids().includes(id) }
  defaultId() {
    const value = this.pluginDefault()
    if (value && this.has(value)) return value
    return this.ids()[0] || ''
  }
  pluginDefault() { return this.defaultValue || '' }
  setDefaultValue(v) { this.defaultValue = v || '' }
  list() {
    const def = this.defaultId()
    return this.ids().map((id) => {
      const m = this.meta(id)
      return { id, email: String(m.email || ''), authMethod: String(m.auth_method || m.authMethod || ''), hasToken: fs.existsSync(this.tokenPath(id)), isDefault: id === def }
    })
  }
  save(id, tokenText, email, authMethod) {
    const dir = path.join(this.dir, id)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, TOKEN_FILE)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, tokenText, { mode: 0o600 })
    fs.renameSync(tmp, file)
    const meta = { ...this.meta(id), email: email || this.meta(id).email || '', auth_method: authMethod || this.meta(id).auth_method || '', updated_at: Date.now() }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 })
  }
  remove(id) {
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true })
  }
}

function parseToken(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('token 不是合法 JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('token 必须是 JSON 对象')
  const inner = data.token && typeof data.token === 'object' ? data.token : data
  if (typeof inner.access_token !== 'string' && typeof inner.refresh_token !== 'string') throw new Error('token 缺少 access_token / refresh_token')
  return {
    raw: data,
    inner,
    email: String(data.id_token_email || inner.id_token_email || '').trim(),
    authMethod: String(data.auth_method || inner.auth_method || '').trim(),
  }
}

function slugId(email, seed) {
  const base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '')
  const candidate = base && /^[a-z0-9]/.test(base) ? base.slice(0, 48) : `account-${seed}`
  return candidate
}

function linkOrSkip(src, dst) {
  try {
    if (fs.existsSync(dst)) return
    const stat = fs.lstatSync(src)
    fs.symlinkSync(src, dst, stat.isDirectory() ? 'dir' : 'file')
  } catch { /* 复制失败不影响主流程 */ }
}

/** 每个原生会话一个 HOME：全局 .gemini 只做软链镜像，token 单独落地。 */
function prepareHome(runtimeDir, tokenText, workspaceDir) {
  const home = path.join(runtimeDir, 'home')
  const ghome = path.join(home, '.gemini')
  fs.mkdirSync(ghome, { recursive: true, mode: 0o700 })
  const source = globalGeminiHome()
  if (source && fs.existsSync(source)) {
    for (const name of fs.readdirSync(source)) {
      if (name === 'antigravity-cli' || KEEP_REAL.has(name)) continue
      linkOrSkip(path.join(source, name), path.join(ghome, name))
    }
    const cliSrc = path.join(source, 'antigravity-cli')
    const cliDst = path.join(ghome, 'antigravity-cli')
    fs.mkdirSync(cliDst, { recursive: true, mode: 0o700 })
    if (fs.existsSync(cliSrc)) {
      for (const name of fs.readdirSync(cliSrc)) {
        if (KEEP_REAL.has(name)) continue
        linkOrSkip(path.join(cliSrc, name), path.join(cliDst, name))
      }
    }
  }
  const cliDir = path.join(ghome, 'antigravity-cli')
  fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 })
  const settingsPath = path.join(cliDir, 'settings.json')
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(path.join(globalGeminiHome(), 'antigravity-cli', 'settings.json'), 'utf8')) } catch { /* 无全局设置 */ }
  const trusted = new Set([...(Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces : []), home, workspaceDir].filter(Boolean))
  settings.trustedWorkspaces = [...trusted]
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  const tokenPath = path.join(cliDir, TOKEN_FILE)
  fs.rmSync(tokenPath, { force: true })
  fs.writeFileSync(tokenPath, tokenText, { mode: 0o600 })
  return home
}

function composePrompt(input, history, instructions) {
  const parts = []
  for (const item of instructions || []) {
    if (!item?.text) continue
    const label = item.kind === 'workspace' ? '工作区信息' : item.kind === 'role' ? '角色' : item.kind === 'task' ? '任务' : '系统说明'
    parts.push(`【${label}】\n${item.text}`)
  }
  if (Array.isArray(history) && history.length) {
    const lines = []
    for (const msg of history.slice(-40)) {
      const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
      if (!text) continue
      lines.push(`【${msg.role === 'assistant' ? '助手' : msg.role === 'tool' ? '工具' : '用户'}】${text}`)
    }
    if (lines.length) parts.push(`【对话历史】\n${lines.join('\n')}`)
  }
  const current = (input || []).map((c) => (c.type === 'text' ? c.text : `[附件 ${c.name}：${c.localPathHint || c.assetId}]`)).join('\n')
  parts.push(current)
  return parts.join('\n\n')
}

function parseModels(text) {
  const models = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^fetching/i.test(line)) continue
    const m = /^(\S+)\s*(?:\t| {2,}| - )\s*(.+)$/.exec(line)
    if (!m) continue
    models.push({ id: m[1], name: m[2].trim(), isDefault: /\bdefault\b/i.test(m[2]) })
  }
  return models
}

function tokenExpired(tokenText) {
  try {
    const d = JSON.parse(tokenText)
    const inner = d.token && typeof d.token === 'object' ? d.token : d
    const exp = inner.expiry || inner.expires_at || ''
    if (!exp) return true
    const ms = Date.parse(exp)
    if (Number.isNaN(ms)) return true
    return ms - Date.now() < 60_000
  } catch { return true }
}

export function apply(ctx) {
  const reg = (name, handler) => { ctx.log.info(`register rpc ${name}`); try { return registerRpc(ctx, contract, name, handler) } catch (e) { ctx.log.error(`rpc ${name} failed: ${e.message}`); throw e } }
  const step = (label) => ctx.log.info(`apply: ${label}`)
  const accounts = new Accounts(ctx.paths.dataDir)
  step('accounts ready')
  ctx.log.info('agy-accounts plugin applied', { dataDir: ctx.paths.dataDir })

  const settingsFile = path.join(ctx.paths.dataDir, 'settings.json')
  const readSettings = () => {
    const base = { defaultAccount: '', defaultModel: '', defaultEffort: '', globalHome: '' }
    try { return { ...base, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch { return base }
  }
  const writeSettings = (next) => {
    const value = { defaultAccount: String(next.defaultAccount || ''), defaultModel: String(next.defaultModel || ''), defaultEffort: String(next.defaultEffort || ''), globalHome: String(next.globalHome || '') }
    fs.writeFileSync(settingsFile, JSON.stringify(value, null, 2), { mode: 0o600 })
    accounts.setDefaultValue(value.defaultAccount)
    return value
  }
  accounts.setDefaultValue(readSettings().defaultAccount)

  const snapshot = () => ({ accounts: accounts.list(), defaultAccount: accounts.defaultId() })
  const sessionState = (run) => run.state.session

  async function catalog(refresh) {
    const id = accounts.defaultId()
    if (!id) return { status: 'auth_required', source: 'agy models', message: '还没有导入 Google 账号', models: [] }
    const probeRoot = path.join(ctx.paths.dataDir, 'probe-home')
    fs.mkdirSync(probeRoot, { recursive: true, mode: 0o700 })
    let probe
    try { probe = prepareHome(probeRoot, accounts.readToken(id), probeRoot) } catch (e) { return { status: 'error', source: 'agy models', message: e.message, models: [] } }
    const res = await run(agyBin(), ['models'], { env: { ...process.env, HOME: probe, USERPROFILE: probe }, timeout: 60_000 })
    const defModel = readSettings().defaultModel
    const models = parseModels(res.out).map((m) => ({ ...m, isDefault: m.id === defModel }))
    if (!models.length) {
      const hint = /sign in|authentication/i.test(res.out + res.err) ? 'auth_required' : res.code === 0 ? 'empty' : 'error'
      return { status: hint, source: `agy models (${id})`, message: (res.err || res.out).slice(0, 400).trim(), models: [] }
    }
    return { status: 'ready', source: `agy models (${id})`, message: refresh ? '已刷新' : '', models }
  }

  step('commands+rpc begin')
  // ---------- RPC：设置页 ----------
  reg('accounts.list', async () => snapshot())
  reg('accounts.add', async (input) => {
    const token = parseToken(input.token)
    const email = String(input.email || token.email || '').trim()
    let id = String(input.id || '').trim()
    if (!id) id = slugId(email, accounts.ids().length + 1)
    if (!Accounts.validId(id)) throw new Error('账号 id 只能包含小写字母、数字、点、下划线、连字符')
    accounts.save(id, input.token.replace(/\r\n/g, '\n').trim() + '\n', email, token.authMethod)
    if (!readSettings().defaultAccount) writeSettings({ ...readSettings(), defaultAccount: id })
    return snapshot()
  })
  reg('accounts.remove', async (input) => {
    if (!accounts.has(input.id)) throw new Error('账号不存在')
    if (input.id === accounts.defaultId()) throw new Error('默认账号不能删除，请先把其他账号设为默认')
    accounts.remove(input.id)
    return snapshot()
  })
  reg('accounts.default', async (input) => {
    if (input.id && !accounts.has(input.id)) throw new Error('账号不存在')
    writeSettings({ ...readSettings(), defaultAccount: input.id })
    return snapshot()
  })
  reg('accounts.import-global', async () => {
    const src = path.join(globalGeminiHome(), 'antigravity-cli', TOKEN_FILE)
    if (!fs.existsSync(src)) throw new Error(`服务器上没有找到全局登录：${src}`)
    const text = fs.readFileSync(src, 'utf8')
    const token = parseToken(text)
    const email = token.email
    const id = slugId(email, accounts.ids().length + 1)
    accounts.save(id, text.replace(/\r\n/g, '\n').trim() + '\n', email, token.authMethod)
    if (!readSettings().defaultAccount) writeSettings({ ...readSettings(), defaultAccount: id })
    return snapshot()
  })
  reg('settings.get', async () => readSettings())
  reg('settings.save', async (input) => writeSettings(input))
  reg('models.list', async () => catalog(true))
  reg('models.set-default', async (input) => {
    const model = String(input.model || '').trim()
    writeSettings({ ...readSettings(), defaultModel: model })
    const syncedSessions = []
    let syncedCount = 0
    if (model) {
      try {
        const res = await ctx.host.sessions.list()
        const items = Array.isArray(res) ? res : (res?.sessions || res?.items || [])
        const targets = items.filter((s) => s?.agent === 'antigravity' || s?.agent === 'plugin:agy-accounts/antigravity')
        for (const s of targets) {
          try {
            await ctx.host.sessions.setModel(s.id, { model, provider: '' })
            syncedSessions.push(s.id)
            syncedCount += 1
          } catch (e) { ctx.log.error(`sync model ${s.id} failed: ${e.message}`) }
        }
      } catch (e) { ctx.log.error(`sync default model failed: ${e.message}`) }
    }
    return { defaultModel: model, syncedCount, syncedSessions }
  })
  reg('accounts.verify', async (input) => {
    if (!accounts.has(input.id)) throw new Error('账号不存在')
    const verifyRoot = path.join(ctx.paths.dataDir, 'verify-home', input.id)
    fs.mkdirSync(verifyRoot, { recursive: true, mode: 0o700 })
    let home
    try { home = prepareHome(verifyRoot, accounts.readToken(input.id), verifyRoot) } catch (e) { return { id: input.id, valid: false, message: e.message } }
    const res = await run(agyBin(), ['models'], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 25_000 })
    if (res.code !== 0 || /sign in|authentication|timed out/i.test(res.out + res.err)) {
      return { id: input.id, valid: false, message: (res.err || res.out || '凭据无效').slice(0, 200).trim() }
    }
    const n = parseModels(res.out).length
    return { id: input.id, valid: n > 0, message: n > 0 ? `凭据有效（${n} 个模型可用）` : '凭据有效但模型目录为空' }
  })

  // ---------- OAuth 授权流程：生成授权链接 + 回填授权码 ----------
  const pluginDir = fileURLToPath(new URL('.', import.meta.url))
  const oauthScript = path.join(pluginDir, 'scripts', 'oauth_pty.py')
  let oauthSession = null // { stateDir, home }

  const readOauthStatus = () => {
    if (!oauthSession) return { state: 'idle', url: '', message: '' }
    try {
      const st = JSON.parse(fs.readFileSync(path.join(oauthSession.stateDir, 'status.json'), 'utf8'))
      return { state: st.state || 'idle', url: st.url || '', message: st.reason || '' }
    } catch { return { state: 'idle', url: '', message: '' } }
  }
  const waitOauthState = async (want, timeoutMs) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const st = readOauthStatus()
      if (want.includes(st.state)) return st
      await new Promise((r) => setTimeout(r, 500))
    }
    return readOauthStatus()
  }

  reg('oauth.start', async () => {
    const ts = Date.now()
    const stateDir = path.join(ctx.paths.dataDir, 'oauth', String(ts))
    const home = path.join(ctx.paths.dataDir, 'oauth-home', String(ts))
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    oauthSession = { stateDir, home }
    const child = spawn('python3', [oauthScript, stateDir, home], {
      detached: true, stdio: 'ignore', env: { ...process.env, AGY_BIN: agyBin() },
    })
    child.unref()
    const st = await waitOauthState(['url', 'error', 'exited'], 20_000)
    if (st.state === 'url') return { state: 'url', url: st.url, message: '请用浏览器打开链接完成 Google 授权，然后把授权码粘贴回来' }
    return { state: st.state, url: '', message: st.message || '授权流程启动失败，请重试' }
  })

  reg('oauth.status', async () => readOauthStatus())

  reg('oauth.complete', async (input) => {
    if (!oauthSession) throw new Error('没有进行中的授权，请先点「获取授权链接」')
    const code = String(input.code || '').trim()
    if (!code) throw new Error('授权码不能为空')
    const cmdDir = path.join(oauthSession.stateDir, 'cmd')
    fs.mkdirSync(cmdDir, { recursive: true })
    fs.writeFileSync(path.join(cmdDir, `${Date.now()}.cmd`), `${code}\r`)
    const st = await waitOauthState(['success', 'error', 'exited'], 90_000)
    if (st.state !== 'success') {
      return { state: st.state, message: st.message || '授权失败或已超时，请重新获取授权链接', accounts: accounts.list(), defaultAccount: accounts.defaultId() }
    }
    // 读取隔离 HOME 里的 token 入库
    const tokenPath = path.join(oauthSession.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    let imported = null
    try {
      const text = fs.readFileSync(tokenPath, 'utf8')
      const token = parseToken(text)
      const email = token.email
      let id = slugId(email, accounts.ids().length + 1)
      if (accounts.has(id)) id = `${id}-${accounts.ids().length + 1}`
      accounts.save(id, text.trim() + '\n', email, token.authMethod)
      if (!readSettings().defaultAccount) writeSettings({ ...readSettings(), defaultAccount: id })
      imported = { id, email }
    } catch (e) {
      oauthSession = null
      return { state: 'success', message: `授权成功但凭据读取失败：${e.message}`, accounts: accounts.list(), defaultAccount: accounts.defaultId() }
    }
    oauthSession = null
    return { state: 'success', message: `已导入账号 ${imported.id}${imported.email ? ` (${imported.email})` : ''}`, importedId: imported.id, importedEmail: imported.email, accounts: accounts.list(), defaultAccount: accounts.defaultId() }
  })

  // ---------- 聊天命令：会话内切换 ----------
  const describeBinding = (run, binding) => {
    const id = binding.account || accounts.defaultId()
    const acc = accounts.list().find((a) => a.id === id)
    const model = binding.model || readSettings().defaultModel || '（agy 默认）'
    return `账号：${id || '未设置'}${acc?.email ? ` (${acc.email})` : ''}　模型：${model}`
  }
  const ensureBinding = (run) => {
    let binding
    try { binding = sessionState(run).get('binding') } catch { binding = undefined }
    return binding || { account: '', model: '', effort: '' }
  }

  ctx.extensions.commands.register({
    name: 'account',
    description: '查看或切换当前会话使用的 Google 账号',
    execute: async (args, run) => {
      const list = accounts.list()
      const wanted = String(args || '').trim()
      if (!wanted) {
        const lines = list.map((a) => `- ${a.id}${a.email ? ` (${a.email})` : ''}${a.isDefault ? ' · 默认' : ''}`)
        return { text: `当前${describeBinding(run, ensureBinding(run))}\n可用账号：\n${lines.join('\n') || '（空）'}\n切换：/agy-accounts:account <id>；复位：/agy-accounts:account default` }
      }
      const target = wanted === 'default' ? '' : wanted
      if (target && !accounts.has(target)) throw new Error(`没有账号 ${target}`)
      await sessionState(run).set('binding', { ...ensureBinding(run), account: target })
      return { text: `已切换本会话账号：${target || `跟随默认（${accounts.defaultId() || '未设置'}）`}` }
    },
  })

  ctx.extensions.commands.register({
    name: 'model',
    description: '查看或切换当前会话使用的模型',
    execute: async (args, run) => {
      const cat = await catalog(false)
      const wanted = String(args || '').trim()
      if (!wanted) {
        const lines = cat.models.map((m) => `- ${m.id} — ${m.name}${m.isDefault ? ' · 默认' : ''}`)
        return { text: `当前${describeBinding(run, ensureBinding(run))}\n可用模型：\n${lines.join('\n') || `（${cat.status}）`}\n切换：/agy-accounts:model <id>；复位：/agy-accounts:model default` }
      }
      const target = wanted === 'default' ? '' : wanted
      if (target && cat.models.length && !cat.models.some((m) => m.id === target)) throw new Error(`模型 ${target} 不在目录中`)
      await sessionState(run).set('binding', { ...ensureBinding(run), model: target })
      return { text: `已切换本会话模型：${target || 'agy 默认'}` }
    },
  })

  step('rpc done')
  // ---------- Agent ----------
  const status = async () => {
    const res = await run(agyBin(), ['--version'], { env: process.env, timeout: 20_000 })
    const version = (res.out || res.err).trim().split('\n')[0]
    if (res.code !== 0 || !version) return { installed: false, version: '', source: agyBin(), path: agyBin(), error: (res.err || res.out).slice(0, 200) }
    return { installed: true, version, source: 'agy CLI', path: agyBin() }
  }

  ctx.extensions.agents.register({
    id: 'antigravity',
    name: '反重力',
    vendor: 'Google Antigravity',
    description: '官方 agy CLI 驱动的反重力智能体，支持多 Google 账号与模型切换。',
    agentApiVersion: 1,
    getStatus: status,
    management: { settings: () => ({ viewId: 'accounts' }) },
    modes: {
      global: {
        listModels: async () => {
          const cat = await catalog(false)
          return { status: cat.status, source: cat.source, scope: 'available', models: cat.models, ...(cat.message ? { message: cat.message } : {}) }
        },
      },
    },
    features: { surfaces: ['chat', 'api', 'workflow'], streaming: true, resume: true },
    runtime: {
      createSession: (sessionCtx) => {
        let conversationId = ''
        try { conversationId = String(sessionCtx.resumeState?.data?.conversationId || '') } catch { conversationId = '' }
        let disposed = false
        let active = null
        return {
          checkpoint: async () => ({ schemaVersion: 1, data: { conversationId } }),
          dispose: () => {
            disposed = true
            try { active?.kill('SIGKILL') } catch { /* 已退出 */ }
          },
          run: async (input, runCtx) => {
            if (disposed) throw new Error('会话已释放')
            let binding = { account: '', model: '', effort: '' }
            try { binding = (await runCtx.state.session.get('binding')) || binding } catch { /* 无会话态 */ }
            const accountId = binding.account || accounts.defaultId()
            if (!accountId) throw new Error('还没有导入 Google 账号：打开插件「反重力账号」页导入 token')
            const tokenText = accounts.readToken(accountId)
            if (!tokenText) throw new Error(`账号 ${accountId} 没有凭据`)

            const texts = (input.input || []).filter((c) => c.type !== 'text')
            for (const item of texts) {
              try {
                const resolved = await runCtx.attachments.resolve(item.assetId)
                item.localPathHint = resolved.localPath
              } catch { /* 解析失败则忽略提示 */ }
            }
            const home = prepareHome(runCtx.paths.runtimeDir, tokenText, runCtx.paths.workspaceDir)
            // token 失效预检：agy models 秒级失败，避免把失效凭据带进 agy run 触发 60s 交互式 OAuth 卡顿
            if (tokenExpired(tokenText)) {
              const probe = await run(agyBin(), ['models'], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 })
              if (probe.code !== 0 || /sign in|authentication|timed out/i.test(probe.out + probe.err)) {
                throw new Error(`账号 ${accountId} 的凭据已失效：请到「反重力账号」设置页重新导入该账号的 token`)
              }
            }
            const model = runCtx.mode === 'global' ? (runCtx.model?.model || '') : ''
            const effort = runCtx.mode === 'global' ? (runCtx.model?.reasoningEffort || '') : ''
            const finalModel = model || binding.model || readSettings().defaultModel
            const finalEffort = effort || binding.effort || readSettings().defaultEffort

            const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json']
            if (finalModel) args.push('--model', finalModel)
            if (finalEffort) args.push('--effort', finalEffort)
            if (conversationId) args.push('--conversation', conversationId)
            const prompt = conversationId
              ? (input.input || []).map((c) => (c.type === 'text' ? c.text : `[附件 ${c.name}：${c.localPathHint || c.assetId}]`)).join('\n')
              : composePrompt(input.input, input.history, input.instructions)
            args.push('-p', prompt)

            await runCtx.output.emit({ type: 'status', phase: 'working', message: `${accountId} · ${finalModel || 'agy 默认'}` })

            const child = spawn(agyBin(), args, {
              cwd: runCtx.paths.workspaceDir,
              env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_STUDIO_SESSION_ID: sessionCtx.identity.sessionId },
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            active = child
            let stderr = ''
            child.stderr.on('data', (d) => { stderr += d })
            const abort = () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
            runCtx.signal.addEventListener('abort', abort, { once: true })

            let buffer = ''
            let text = ''
            let usage = null
            let status = ''
            let failure = ''
            const toolCalls = new Map()
            const handle = async (line) => {
              const trimmed = line.trim()
              if (!trimmed.startsWith('{')) return
              let data
              try { data = JSON.parse(trimmed) } catch { return }
              if (data.event === 'init') {
                if (typeof data.conversation_id === 'string') conversationId = data.conversation_id
                return
              }
              if (data.event === 'step_update' && data.step_update) {
                const step = data.step_update
                if (typeof step.conversation_id === 'string' && step.conversation_id) conversationId = step.conversation_id
                if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
                  text += step.text_delta
                  await runCtx.output.emit({ type: 'text.delta', text: step.text_delta })
                }
                if (step.step_type === 'tool' && step.tool_name) {
                  const callId = `step-${step.step_index}`
                  if (step.state === 'ACTIVE' && !toolCalls.has(callId)) {
                    toolCalls.set(callId, step.tool_name)
                    await runCtx.output.emit({ type: 'tool.started', callId, name: step.tool_name, input: step.tool_info?.parameters || {} })
                  } else if (step.state === 'DONE' && toolCalls.has(callId)) {
                    const output = step.tool_info?.output
                    if (typeof output === 'string' && /failed|not permitted|error/i.test(output)) {
                      await runCtx.output.emit({ type: 'tool.failed', callId, error: output.slice(0, 2000) })
                    } else {
                      await runCtx.output.emit({ type: 'tool.completed', callId, result: output === undefined ? null : String(output).slice(0, 4000) })
                    }
                    toolCalls.delete(callId)
                  }
                }
                if (step.usage) usage = step.usage
                return
              }
              if (data.event === 'result' && data.result) {
                const result = data.result
                status = String(result.status || '')
                if (typeof result.conversation_id === 'string' && result.conversation_id) conversationId = result.conversation_id
                if (typeof result.response === 'string' && result.response) text = result.response
                if (result.usage) usage = result.usage
                if (result.error) failure = String(result.error)
              }
            }

            const stream = new Promise((resolve, reject) => {
              child.stdout.on('data', (chunk) => {
                buffer += chunk
                const parts = buffer.split('\n')
                buffer = parts.pop() || ''
                for (const part of parts) handle(part).catch(() => {})
              })
              child.on('error', reject)
              child.on('close', () => resolve())
            })
            const timer = setTimeout(abort, Math.max(30_000, Math.min(runCtx.deadlineAt - Date.now(), 3_600_000)))
            try {
              await stream
              if (buffer.trim()) await handle(buffer)
            } finally {
              clearTimeout(timer)
              runCtx.signal.removeEventListener('abort', abort)
              active = null
            }
            if (runCtx.signal.aborted) throw new Error('已取消')
            if (failure || status === 'ERROR') {
              const signInHint = /sign in|authentication/i.test(stderr) ? '（凭据可能已失效，请到「反重力账号」页重新导入 token）' : ''
              throw new Error(`${failure || '反重力运行失败'}${signInHint}`)
            }
            for (const [callId, name] of toolCalls) {
              await runCtx.output.emit({ type: 'tool.failed', callId, error: `${name} 未返回结果` })
            }
            const content = [{ type: 'text', text: text.trim() }]
            const finishReason = 'stop'
            return {
              content,
              finishReason,
              ...(usage
                ? {
                    usage: {
                      inputTokens: Number(usage.input_tokens) || 0,
                      outputTokens: Number(usage.output_tokens) || 0,
                      cacheReadTokens: Number(usage.cache_read_tokens) || 0,
                      costUsd: null,
                      isEstimated: false,
                    },
                  }
                : {}),
              checkpoint: { schemaVersion: 1, data: { conversationId } },
            }
          },
        }
      },
    },
  })

  step('agent registered')
  return () => { /* 无后台资源 */ }
}
