import { readFileSync, existsSync } from 'node:fs'
import { assertContracts } from '../sdk/harness/contracts.mjs'

const fail = (msg) => { console.error(`[harness] ${msg}`); process.exitCode = 1 }
const ok = (msg) => console.log(`[harness] ok  ${msg}`)

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const contract = assertContracts(JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8')))
ok('contracts/plugin.json 通过结构校验')

if (manifest.version !== pkg.version) fail('plugin.json 与 package.json 版本不一致')
else ok(`版本一致 ${manifest.version}`)

for (const key of ['id', 'name', 'version']) if (!manifest[key]) fail(`plugin.json 缺少 ${key}`)
if (!/^[a-z][a-z0-9._-]{0,79}$/.test(manifest.id || '')) fail('plugin id 不合规')
if (manifest.apiVersion !== 1) fail('apiVersion 必须为 1')
if (!Array.isArray(manifest.permissions)) fail('permissions 必须是数组')
for (const entry of [manifest.server, manifest.client].filter(Boolean)) {
  if (!existsSync(new URL(`../${entry}`, import.meta.url))) fail(`入口文件不存在：${entry}`)
}
ok('清单字段与入口文件齐备')

for (const view of manifest.views || []) {
  if (!['page', 'settings', 'workspace', 'agent-settings'].includes(view.slot)) fail(`视图 ${view.id} slot 非法`)
  if (['workspace', 'agent-settings'].includes(view.slot) && !view.icon) fail(`视图 ${view.id} 需要命名 icon`)
  if (view.icon && /[/.]/.test(view.icon)) fail(`视图 ${view.id} icon 应为命名图标`)
}
for (const [group, entries] of Object.entries(manifest.navigation || {})) {
  for (const entry of entries || []) {
    if (!entry.icon) fail(`navigation.${group} 的 ${entry.viewId} 缺少 icon`)
    if (!(manifest.views || []).some((v) => v.id === entry.viewId)) fail(`navigation.${group} 指向未声明的视图 ${entry.viewId}`)
  }
}
ok('views / navigation 校验通过')

for (const [name, entry] of Object.entries(contract.rpc)) {
  if (!entry.description?.trim()) fail(`rpc ${name} 缺少 description`)
}
ok(`rpc 声明 ${Object.keys(contract.rpc).length} 个`)
console.log(process.exitCode ? '[harness] FAILED' : '[harness] all checks passed')
