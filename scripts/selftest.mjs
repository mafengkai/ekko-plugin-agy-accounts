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
assert([...registrations.rpc.keys()].sort().join(',') === 'accounts.add,accounts.default,accounts.import-global,accounts.list,accounts.remove,accounts.verify,models.list,models.set-default,oauth.complete,oauth.start,oauth.status,settings.get,settings.save', 'RPC 全部注册')
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
