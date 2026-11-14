/**
 * 自测：用最小 ctx 桩加载 server.mjs，验证注册、账号库、模型目录与运行器接线。
 * 不写真实账号库（用临时目录），不调用付费模型（除 models 目录查询）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-test-'))
const registrations = { rpc: new Map(), commands: new Map(), agents: new Map() }

const sessionStore = new Map()
const makeStore = () => ({
  get: async (k) => sessionStore.get(k),
  set: async (k, v) => { sessionStore.set(k, v) },
  delete: async (k) => { sessionStore.delete(k) },
  keys: async () => [...sessionStore.keys()],
  namespace: () => makeStore(),
})
const emptyStore = makeStore()

const ctx = {
  plugin: { id: 'agy-accounts' },
  identity: { userId: 1, profile: 'default' },
  config: {},
  signal: new AbortController().signal,
  paths: { dataDir },
  log: { info() {}, warn() {}, error() {} },
  lifecycle: { add() {}, acquire: async () => () => {} },
  state: { plugin: emptyStore, user: emptyStore, profile: emptyStore, session: makeStore() },
  host: {},
  events: { on: () => () => {} },
  scheduler: { every: () => () => {} },
  extensions: {
    rpc: { register: (name, handler) => { registrations.rpc.set(name, handler); return () => {} } },
    commands: { register: (def) => { registrations.commands.set(def.name, def); return () => {} } },
    agents: { register: (def) => { registrations.agents.set(def.id, def); return { id: `plugin:agy-accounts/${def.id}`, dispose: async () => {} } } },
  },
}

const assert = (cond, msg) => { if (!cond) { console.error(`FAIL ${msg}`); process.exitCode = 1 } else console.log(`ok   ${msg}`) }

const { apply } = await import('../server.mjs')
apply(ctx)

assert(registrations.agents.has('antigravity'), '注册了 antigravity agent')
assert([...registrations.rpc.keys()].sort().join(',') === 'accounts.add,accounts.default,accounts.import-global,accounts.list,accounts.remove,accounts.verify,engine.status,models.list,models.set-default,oauth.complete,oauth.start,oauth.status,settings.get,settings.save', 'RPC 全部注册')
assert([...registrations.commands.keys()].sort().join(',') === 'account,model', '聊天命令注册')

const agent = registrations.agents.get('antigravity')
const st = await agent.getStatus({})
assert(st.installed === true && /^\d+\.\d+/.test(st.version), `引擎可用（${st.version}）`)
const target = agent.management.settings({})
assert(target.viewId === 'accounts', 'management.settings 指向 accounts 视图')

const empty = await registrations.rpc.get('models.list')({})
assert(empty.status === 'auth_required' && empty.models.length === 0, '无账号时目录报 auth_required')

const ost = await registrations.rpc.get('oauth.status')({})
assert(ost.state === 'idle', 'oauth.status 初始为 idle')

const engine = await registrations.rpc.get('engine.status')({})
assert(engine.agy?.installed === true && typeof engine.agy.version === 'string', `engine.status 报出 agy（${engine.agy?.version}）`)
assert(engine.python?.ok === true && /^\d+\./.test(engine.python.version), `engine.status 报出 Python 驱动（${engine.python?.bin} ${engine.python?.version}）`)
assert(engine.oauth?.supported === true, 'engine.status 判定无头授权可用')

// 回归：解释器缺失时必须返回可读错误，不能因 spawn error 未处理而崩掉宿主进程
process.env.AGY_OAUTH_PYTHON = '/nonexistent/python3'
const noPy = await registrations.rpc.get('oauth.start')({})
assert(noPy.state === 'error' && /Python/.test(noPy.message), `缺 Python 时报错而非崩溃（${noPy.state}）`)
const engineNoPy = await registrations.rpc.get('engine.status')({})
assert(engineNoPy.python.ok === false && engineNoPy.oauth.supported === false && /Python/.test(engineNoPy.oauth.reason), 'engine.status 反映 Python 缺失')
delete process.env.AGY_OAUTH_PYTHON

// 回归：agy 缺失时给出安装指引，而不是空等 20 秒后只说“请重试”
const realBin = process.env.AGY_BIN
process.env.AGY_BIN = '/nonexistent/agy'
const noAgy = await registrations.rpc.get('oauth.start')({})
assert(noAgy.state === 'error' && /agy CLI/.test(noAgy.message), `缺 agy 时给出安装指引（${noAgy.state}）`)
const engineNoAgy = await registrations.rpc.get('engine.status')({})
assert(engineNoAgy.agy.installed === false && engineNoAgy.oauth.supported === false, 'engine.status 反映 agy 缺失')
if (realBin === undefined) delete process.env.AGY_BIN
else process.env.AGY_BIN = realBin

const globalToken = path.join(process.env.AGY_GLOBAL_HOME || path.join(os.homedir(), '.gemini'), 'antigravity-cli', 'antigravity-oauth-token')
if (fs.existsSync(globalToken)) {
  const list = await registrations.rpc.get('accounts.import-global')({})
  assert(list.accounts.length === 1 && list.accounts[0].hasToken, '从全局登录导入账号成功')
  assert(list.defaultAccount === list.accounts[0].id, '首个账号自动成为默认')
  const cat = await registrations.rpc.get('models.list')({})
  assert(cat.status === 'ready' && cat.models.length >= 3, `模型目录可用（${cat.models.length} 个）`)
  assert(cat.models.every((m) => m.id && m.name), '模型条目字段完整')
  const listed = await registrations.rpc.get('accounts.list')({})
  assert(!JSON.stringify(listed).includes('ya29.'), '返回里不含 access_token 明文')
  let rejected = false
  try { await registrations.rpc.get('accounts.add')({ token: '{"nope":1}' }) } catch { rejected = true }
  assert(rejected, '非法 token 被拒绝')
} else {
  console.log('skip 全局登录不存在，跳过目录测试')
}

try { await registrations.commands.get('account').execute('', { state: { session: makeStore() } }); assert(true, '账号命令可执行') } catch (e) { assert(false, `账号命令异常：${e.message}`) }

fs.rmSync(dataDir, { recursive: true, force: true })
console.log(process.exitCode ? 'SELFTEST FAILED' : 'SELFTEST PASSED')
