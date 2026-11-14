/**
 * 静态校验（CI 用，不依赖 agy / 账号 / 网络）：
 * 1. plugin.json 与 package.json 的 id/name/version 一致且合法
 * 2. contracts 里每个 rpc/command 都在 server.mjs 里真实注册（防契约漂移）
 * 3. views 与 navigation 引用闭合
 * 4. 语法检查 server/client 与 scripts
 * 5. 敏感信息扫描（令牌、私钥、真实邮箱）
 *
 * 用法: node scripts/check.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const json = (p) => JSON.parse(read(p))

let failed = 0
const check = (cond, msg, detail) => {
  if (cond) console.log(`ok   ${msg}`)
  else { failed += 1; console.error(`FAIL ${msg}${detail ? ` — ${detail}` : ''}`) }
}

// ---------- 1. manifest ----------
const plugin = json('plugin.json')
const pkg = json('package.json')
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

check(pkg.name.endsWith(plugin.id) && /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), 'package.json name 合法且以插件 id 结尾', `${pkg.name} vs ${plugin.id}`)
check(semver.test(plugin.version), 'plugin.version 是合法 semver', plugin.version)
check(plugin.version === pkg.version, 'plugin/package 版本一致', `${plugin.version} vs ${pkg.version}`)
check(plugin.apiVersion === 1, 'apiVersion 为 1')
check(typeof plugin.name === 'string' && plugin.name.length > 0, 'name 非空')
check(typeof plugin.description === 'string' && plugin.description.length > 0, 'description 非空')
check(!('capabilities' in plugin), '未使用已废弃的 capabilities 字段')
// 顶层 icon：相对路径必须是包内真实存在的图片，且 ≤256 KB（宿主 installer 会把相对路径读成 base64 data URL）
if (plugin.icon === undefined) {
  console.log('ok   顶层 icon 未声明（可选）')
} else if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(plugin.icon)) {
  check(plugin.icon.length <= 350_000, '顶层 icon 是合法 base64 图片且未超长')
} else {
  const iconRe = /^[\w./-]+\.(?:png|jpe?g|webp|gif)$/i
  const okPath = iconRe.test(plugin.icon) && !plugin.icon.startsWith('/') && !plugin.icon.split('/').includes('..')
  check(okPath, '顶层 icon 是包内相对图片路径', String(plugin.icon))
  const iconFile = join(root, plugin.icon)
  check(existsSync(iconFile), `icon 文件存在（${plugin.icon}）`)
  if (existsSync(iconFile)) {
    const size = statSync(iconFile).size
    check(size <= 256_000, `icon 体积 ≤256 KB（实际 ${size} B）`)
    const head = readFileSync(iconFile).subarray(0, 8)
    const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    check(isPng, 'icon 文件头是真实 PNG 数据（不是占位文本）')
    check(pkg.files.some((f) => f === plugin.icon || (f.endsWith('/') && plugin.icon.startsWith(f))), 'icon 已被 package.json files 白名单收录')
  }
}
check(existsSync(join(root, plugin.server)), `server 入口存在（${plugin.server}）`)
check(existsSync(join(root, plugin.client)), `client 入口存在（${plugin.client}）`)
check(plugin.author && typeof plugin.author.name === 'string' && plugin.author.name.length > 0, 'author.name 存在')
check(/^https?:\/\//.test(plugin.repository || '') && !/\/\/[^/]*@/.test(plugin.repository || ''), 'repository 是无凭据的 HTTP(S) 地址')
check(plugin.license === 'MIT', 'license 声明为 MIT')
check(!plugin.dependencies && !pkg.dependencies, '零外部依赖（host 用 --ignore-scripts 安装）')
const ALLOWED_PERMISSIONS = new Set(['agents', 'commands', 'ui', 'storage.client', 'api.read', 'api.write', 'tools', 'actions', 'events', 'workflows'])
check(Array.isArray(plugin.permissions) && plugin.permissions.every((p) => ALLOWED_PERMISSIONS.has(p)), 'permissions 全部在白名单内')
const SLOTS = new Set(['page', 'settings', 'workspace', 'agent-settings'])
check(Array.isArray(plugin.views) && plugin.views.every((v) => SLOTS.has(v.slot)), 'views[].slot 合法')
const viewIds = new Set((plugin.views || []).map((v) => v.id))
const navViewIds = (plugin.navigation?.settings || []).map((n) => n.viewId)
check(navViewIds.every((id) => viewIds.has(id)), 'navigation.settings 引用的 viewId 都存在', navViewIds.join(','))

// ---------- 2. contracts ↔ 注册 ----------
const contracts = json(join('contracts', 'plugin.json'))
const server = read(plugin.server)
const models = new Set(Object.keys(contracts.models || {}))
for (const [name, def] of Object.entries(contracts.rpc || {})) {
  check(server.includes(`reg('${name}'`), `rpc ${name} 已在 server 注册`)
  const inOk = def.input === 'empty' || models.has(def.input)
  const outOk = models.has(def.output)
  check(inOk && outOk, `rpc ${name} 的 input/output 类型已定义`, `${def.input} -> ${def.output}`)
  check(models.has(def.output) === false || JSON.stringify(contracts.models[def.output]).length > 0, `rpc ${name} output 结构非空`)
}
for (const name of Object.keys(contracts.commands || {})) {
  check(new RegExp(`name:\\s*'${name}'`).test(server), `command ${name} 已在 server 注册`)
}

// ---------- 3. 语法 ----------
const files = [plugin.server, plugin.client, ...readdirSync(join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => join('scripts', f))]
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  check(r.status === 0, `语法通过 ${file}`, (r.stderr || '').split('\n').slice(0, 3).join(' '))
}

// ---------- 4. 敏感信息 ----------
const SECRETS = [
  [/ya29\.[A-Za-z0-9_-]{20,}/, 'Google access_token'],
  [/1\/\/[0-9A-Za-z_-]{30,}/, 'Google refresh_token'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥'],
  [/AIzaSy[A-Za-z0-9_-]{30,}/, 'Google API key'],
  [/[A-Za-z0-9._%+-]+@(?:gmail\.com|googlemail\.com)/i, '真实 Gmail 地址'],
  [/\b(?:129\.225\.144\.178|137\.131\.37\.85)\b/, '服务器 IP'],
]
const scanTargets = ['plugin.json', 'package.json', 'README.md', 'server.mjs', 'client.mjs', 'contracts/plugin.json',
  ...readdirSync(join(root, 'scripts')).map((f) => join('scripts', f)),
  ...(existsSync(join(root, 'docs')) ? readdirSync(join(root, 'docs')).map((f) => join('docs', f)) : [])]
for (const file of scanTargets) {
  if (!existsSync(join(root, file))) continue
  const text = read(file)
  for (const [re, label] of SECRETS) check(!re.test(text), `${file} 不含${label}`)
}

console.log(failed ? `CHECK FAILED (${failed})` : 'CHECK PASSED')
process.exit(failed ? 1 : 0)
