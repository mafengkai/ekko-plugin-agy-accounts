/** 端到端跑一轮真实 agy：验证 HOME 隔离、模型参数、流式事件、usage、checkpoint。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGY_GLOBAL_HOME = process.env.AGY_GLOBAL_HOME || '/opt/data/gemini-home'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-run-'))
const registrations = { rpc: new Map(), commands: new Map(), agents: new Map() }
const sessionStore = new Map()
const makeStore = () => ({ get: async (k) => sessionStore.get(k), set: async (k, v) => { sessionStore.set(k, v) }, delete: async (k) => { sessionStore.delete(k) }, keys: async () => [...sessionStore.keys()], namespace: () => makeStore() })
const empty = makeStore()
const ctx = {
  plugin: { id: 'agy-accounts' }, identity: { userId: 1, profile: 'default' }, config: {},
  signal: new AbortController().signal, paths: { dataDir },
  log: { info() {}, warn() {}, error() {} }, lifecycle: { add() {}, acquire: async () => () => {} },
  state: { plugin: empty, user: empty, profile: empty, session: makeStore() },
  host: {}, events: { on: () => () => {} }, scheduler: { every: () => () => {} },
  extensions: {
    rpc: { register: (n, h) => { registrations.rpc.set(n, h); return () => {} } },
    commands: { register: (n, d) => { registrations.commands.set(n, d); return () => {} } },
    agents: { register: (d) => { registrations.agents.set(d.id, d); return { id: `plugin:agy-accounts/${d.id}`, dispose: async () => {} } } },
  },
}
const { apply } = await import('../server.mjs')
apply(ctx)
const imported = await registrations.rpc.get('accounts.import-global')({})
const accountId = imported.defaultAccount

const agent = registrations.agents.get('antigravity')
const runtimeDir = path.join(dataDir, 'runtime')
const workspaceDir = path.join(dataDir, 'workspace')
fs.mkdirSync(runtimeDir, { recursive: true }); fs.mkdirSync(workspaceDir, { recursive: true })

const events = []
const session = await agent.runtime.createSession({ identity: { userId: 1, profile: 'default', agentId: 'plugin:agy-accounts/antigravity', sessionId: 'testsession' }, mode: 'global', paths: { runtimeDir, workspaceDir }, signal: new AbortController().signal, log: ctx.log, lifecycle: ctx.lifecycle })

const runCtx = {
  identity: { userId: 1, profile: 'default', agentId: 'plugin:agy-accounts/antigravity', sessionId: 'testsession', runId: 'run1' },
  mode: 'global',
  model: { model: 'gemini-3.8-flash-low', reasoningEffort: 'low' },
  paths: { runtimeDir, workspaceDir },
  deadlineAt: Date.now() + 300000,
  signal: new AbortController().signal,
  log: ctx.log, lifecycle: ctx.lifecycle,
  state: { ...empty, agentSession: makeStore(), session: makeStore() },
  output: { emit: async (e) => { events.push(e) } },
  mcpServers: {},
  interactions: { approve: async () => ({ outcome: 'approved' }), clarify: async () => ({ outcome: 'dismissed' }) },
  attachments: { resolve: async () => ({ localPath: '' }), read: async () => new Uint8Array() },
  config: {}, permissions: [], features: [], host: {}, messages: { notify() {}, emit() {} }, tools: { call: async () => ({ ok: true, content: '' }) }, workspace: { read: async () => '', write: async () => {} }, session: { get: async () => ({}) },
}

const t0 = Date.now()
const result = await session.run({ input: [{ type: 'text', text: '只回复两个字：正常' }], history: [], instructions: [{ kind: 'system', text: '你很简洁。' }], options: {} }, runCtx)
const elapsed = Date.now() - t0

console.log('account     :', accountId)
console.log('home        :', fs.existsSync(path.join(runtimeDir, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token')) ? 'token 已落地' : '缺失')
console.log('elapsed_ms  :', elapsed)
console.log('deltas      :', events.filter((e) => e.type === 'text.delta').length)
console.log('status      :', events.filter((e) => e.type === 'status').map((e) => e.message))
console.log('content     :', JSON.stringify(result.content))
console.log('finishReason:', result.finishReason)
console.log('usage       :', JSON.stringify(result.usage))
console.log('checkpoint  :', JSON.stringify(result.checkpoint))
console.log('HOME 未污染全局:', fs.readFileSync('/opt/data/gemini-home/antigravity-cli/antigravity-oauth-token', 'utf8') === fs.readFileSync(path.join(dataDir, 'accounts', accountId, 'antigravity-oauth-token'), 'utf8') ? '一致（仅导入副本）' : '不同（需确认）')
fs.rmSync(dataDir, { recursive: true, force: true })
