/**
 * 反重力多账号 —— 设置页（agent-settings）。
 * 只通过 ctx.rpc 调后端；不联网、不读宿主存储。
 * 布局：默认账号（下拉，全局生效）→ 账号列表（查看/验证/删除）→ 导入 → 默认模型。
 */
const CSS = `
.agy { font: 13px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--text-primary, #1f2328); max-width: 820px; }
.agy h2 { font-size: 15px; margin: 20px 0 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border-color, #e5e7eb); }
.agy h2:first-child { margin-top: 0; }
.agy p.hint { color: var(--text-secondary, #6b7280); margin: 4px 0 10px; font-size: 12px; }
.agy p.hint.bad { color: #b42318; }
.agy .row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--border-color, #e5e7eb); border-radius: 8px; margin-bottom: 8px; background: var(--surface-primary, #fff); }
.agy .row .who { flex: 1; min-width: 0; }
.agy .row .who b { font-weight: 600; }
.agy .row .who .email { color: var(--text-secondary, #6b7280); font-size: 12px; }
.agy .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--surface-tertiary, #f3f4f6); color: var(--text-secondary, #6b7280); margin-right: 4px; }
.agy .tag.ok { background: #e6f4ea; color: #1e7e34; }
.agy .tag.badge { background: #e8f0fe; color: #1a56db; }
.agy button { font: inherit; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--border-color, #d1d5db); background: var(--surface-primary, #fff); color: inherit; cursor: pointer; }
.agy button:hover { filter: brightness(0.97); }
.agy button:disabled { opacity: 0.5; cursor: default; }
.agy button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.agy button.danger { color: #b42318; border-color: #f3b4ad; }
.agy textarea { width: 100%; min-height: 100px; font: 12px/1.5 ui-monospace, Menlo, monospace; padding: 8px; border-radius: 6px; border: 1px solid var(--border-color, #d1d5db); box-sizing: border-box; background: var(--surface-primary, #fff); color: inherit; }
.agy input[type=text] { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border-color, #d1d5db); min-width: 200px; background: var(--surface-primary, #fff); color: inherit; }
.agy select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-color, #d1d5db); background: var(--surface-primary, #fff); color: inherit; max-width: 100%; }
.agy .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.agy .msg { min-height: 20px; font-size: 12px; color: var(--text-secondary, #6b7280); margin-top: 8px; }
.agy .msg.err { color: #b42318; }
.agy .urlbox { flex: 1; min-width: 0; font: 12px/1.5 ui-monospace, Menlo, monospace; user-select: all; }
.agy a.btnlink { display: inline-block; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--border-color, #d1d5db); background: var(--surface-primary, #fff); color: #1a56db; text-decoration: none; cursor: pointer; white-space: nowrap; }
.agy a.btnlink:hover { filter: brightness(0.97); }
`

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const child of children) if (child !== undefined && child !== null) node.append(child)
  return node
}

export async function mount(root, ctx) {
  const style = el('style', { textContent: CSS })
  const wrap = el('div', { className: 'agy' })
  root.append(style, wrap)

  const message = el('div', { className: 'msg' })
  const say = (text, isError) => {
    message.textContent = text || ''
    message.className = isError ? 'msg err' : 'msg'
  }

  let state = { accounts: [], defaultAccount: '' }
  let startOauthBtn = null

  // ---------- 运行环境自检 ----------
  const engineBox = el('div')
  const engineHint = el('p', { className: 'hint', textContent: '正在检测 agy 引擎与授权驱动…' })
  const recheckBtn = el('button', { textContent: '重新检测' })
  const renderEngine = (st) => {
    const lines = []
    lines.push(st.agy.installed ? `引擎 agy ${st.agy.version}` : `引擎 agy 未安装（${st.agy.bin}）`)
    lines.push(st.python.ok ? `授权驱动 ${st.python.bin} ${st.python.version}` : '授权驱动 Python 未找到')
    lines.push(st.oauth.supported ? '无头授权：可用' : `无头授权：不可用（${st.oauth.reason}）`)
    engineHint.textContent = lines.join('　·　')
    engineHint.className = st.oauth.supported ? 'hint' : 'hint bad'
    if (startOauthBtn) startOauthBtn.disabled = !st.oauth.supported
  }
  const refreshEngine = async () => {
    try { renderEngine(await ctx.rpc.call('engine.status', {})) }
    catch (e) { engineHint.textContent = `环境自检失败：${e.message}`; engineHint.className = 'hint bad' }
  }
  recheckBtn.onclick = () => { say('正在重新检测…'); refreshEngine() }
  engineBox.append(el('div', { className: 'line' }, recheckBtn), engineHint)

  const defaultSelect = el('select')
  const accountBox = el('div')
  const modelSelect = el('select')
  const tokenArea = el('textarea', { placeholder: '把 antigravity-oauth-token 文件的完整内容粘贴到这里（{"access_token": ...}）' })
  const emailInput = el('input', { type: 'text', placeholder: '邮箱（可选，用于显示）' })

  // ---------- 默认账号下拉（全局生效） ----------
  const renderDefaultSelect = () => {
    defaultSelect.replaceChildren()
    if (!state.accounts.length) {
      defaultSelect.append(el('option', { value: '', textContent: '暂无账号' }))
      defaultSelect.disabled = true
      return
    }
    defaultSelect.disabled = false
    for (const account of state.accounts) {
      defaultSelect.append(el('option', { value: account.id, textContent: `${account.id}${account.email ? ` · ${account.email}` : ''}` }))
    }
    defaultSelect.value = state.defaultAccount || state.accounts[0].id
  }
  defaultSelect.onchange = async () => {
    const id = defaultSelect.value
    try {
      state = await ctx.rpc.call('accounts.default', { id })
      renderDefaultSelect()
      say(id ? `默认账号已设为 ${id}，对所有反重力会话全局生效` : '已清除默认账号')
    } catch (e) { say(e.message, true); renderDefaultSelect() }
  }

  // ---------- 账号列表 ----------
  const renderAccounts = () => {
    accountBox.replaceChildren()
    if (!state.accounts.length) {
      accountBox.append(el('p', { className: 'hint', textContent: '还没有账号。点下方「导入服务器上的登录」，或粘贴 token JSON 添加。' }))
      return
    }
    for (const account of state.accounts) {
      const row = el('div', { className: 'row' })
      const who = el('div', { className: 'who' })
      who.append(el('b', { textContent: account.id }))
      if (account.email) who.append(el('div', { className: 'email', textContent: account.email }))
      const tags = el('div')
      if (account.isDefault) tags.append(el('span', { className: 'tag badge', textContent: '默认' }))
      tags.append(el('span', { className: `tag${account.hasToken ? ' ok' : ''}`, textContent: account.hasToken ? '凭据就绪' : '缺凭据' }))
      if (account.authMethod) tags.append(el('span', { className: 'tag', textContent: account.authMethod }))
      who.append(tags)
      row.append(who)

      const verifyBtn = el('button', { textContent: '验证' })
      verifyBtn.onclick = async () => {
        verifyBtn.disabled = true
        verifyBtn.textContent = '验证中…'
        try {
          const r = await ctx.rpc.call('accounts.verify', { id: account.id })
          say(`${account.id}：${r.message}`, !r.valid)
        } catch (e) { say(e.message, true) } finally { verifyBtn.disabled = false; verifyBtn.textContent = '验证' }
      }
      const del = el('button', { className: 'danger', textContent: '删除' })
      del.onclick = async () => {
        if (!(await ctx.ui.confirm(`删除账号 ${account.id}？（只删插件内的凭据副本）`))) return
        try {
          state = await ctx.rpc.call('accounts.remove', { id: account.id })
          renderAccounts(); renderDefaultSelect()
          say('已删除')
        } catch (e) { say(e.message, true) }
      }
      row.append(verifyBtn, del)
      accountBox.append(row)
    }
  }

  // ---------- 模型目录 ----------
  const refreshModels = async () => {
    try {
      const cat = await ctx.rpc.call('models.list', {})
      modelSelect.replaceChildren(el('option', { value: '', textContent: '跟随 agy 默认' }))
      for (const model of cat.models) modelSelect.append(el('option', { value: model.id, textContent: `${model.name}${model.isDefault ? '（默认）' : ''}` }))
      if (!cat.models.length) say(`模型目录：${cat.status}${cat.message ? ` — ${cat.message}` : ''}`, cat.status === 'error')
      return cat
    } catch (e) { say(e.message, true); return { models: [] } }
  }

  // ---------- 布局 ----------
  // 0. 运行环境
  wrap.append(el('h2', { textContent: '运行环境' }), engineBox)

  // 1. 默认账号
  wrap.append(el('h2', { textContent: '默认账号' }))
  wrap.append(el('p', { className: 'hint', textContent: '下拉选择的是全局默认账号，对所有反重力会话立即生效；单个会话里可用 /agy-accounts:account <id> 临时切换。' }))
  wrap.append(el('div', { className: 'line' }, defaultSelect))

  // 2. 账号列表
  wrap.append(el('h2', { textContent: 'Google 账号' }))
  wrap.append(el('p', { className: 'hint', textContent: '每个账号一份 OAuth 凭据，只保存在插件私有目录，绝不外发。' }))
  wrap.append(accountBox)

  // 2.5 添加账号：OAuth 授权
  wrap.append(el('h2', { textContent: '添加账号（OAuth 授权）' }))
  wrap.append(el('p', { className: 'hint', textContent: '点「获取授权链接」，在浏览器打开链接登录 Google 账号，授权后把授权码粘贴回来即可自动导入。' }))
  const oauthBox = el('div')
  startOauthBtn = el('button', { className: 'primary', textContent: '获取授权链接' })
  const oauthUrlBox = el('input', { type: 'text', placeholder: '点击上方按钮生成授权链接…', readOnly: true, className: 'urlbox' })
  oauthUrlBox.addEventListener('click', () => oauthUrlBox.select())
  oauthUrlBox.addEventListener('focus', () => oauthUrlBox.select())
  const copyOauthBtn = el('button', { textContent: '复制链接' })
  const openOauthLink = el('a', { href: '#', target: '_blank', rel: 'noopener noreferrer', textContent: '在浏览器打开', className: 'btnlink' })
  const codeInput = el('input', { type: 'text', placeholder: '粘贴浏览器显示的授权码…' })
  const submitCodeBtn = el('button', { className: 'primary', textContent: '提交授权码' })

  const setOauthUrl = (url) => {
    oauthUrlBox.value = url || ''
    openOauthLink.href = url || '#'
    openOauthLink.style.display = url ? '' : 'none'
    copyOauthBtn.disabled = !url
  }

  startOauthBtn.onclick = async () => {
    try {
      startOauthBtn.disabled = true
      say('正在生成授权链接…')
      const r = await ctx.rpc.call('oauth.start', {})
      if (r.state === 'url') {
        setOauthUrl(r.url)
        say(r.message || '请在浏览器打开链接授权')
      } else {
        setOauthUrl('')
        say(r.message || '授权流程启动失败', true)
      }
    } catch (e) { say(e.message, true) } finally { startOauthBtn.disabled = false }
  }

  copyOauthBtn.onclick = async () => {
    const url = oauthUrlBox.value
    if (!url) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(url); return say('已复制链接') } catch (e) {}
    }
    try {
      oauthUrlBox.focus(); oauthUrlBox.select()
      const ok = document.execCommand('copy')
      return say(ok ? '已复制链接' : '复制失败，请点击链接框后按 Ctrl+C', !ok)
    } catch (e) { return say('复制失败，请手动选中复制', true) }
  }

  submitCodeBtn.onclick = async () => {
    const code = codeInput.value.trim()
    if (!code) { say('请先粘贴授权码', true); return }
    try {
      submitCodeBtn.disabled = true
      say('正在兑换授权码…')
      const r = await ctx.rpc.call('oauth.complete', { code })
      if (r.state === 'success') {
        say(r.message || '已导入账号')
        state = { accounts: r.accounts, defaultAccount: r.defaultAccount }
        renderAccounts(); renderDefaultSelect()
        setOauthUrl('')
        codeInput.value = ''
      } else {
        say(r.message || '授权失败', true)
      }
    } catch (e) { say(e.message, true) } finally { submitCodeBtn.disabled = false }
  }

  oauthBox.append(startOauthBtn)
  oauthBox.append(el('div', { className: 'line' }, oauthUrlBox, copyOauthBtn, openOauthLink))
  oauthBox.append(el('div', { className: 'line' }, codeInput, submitCodeBtn))
  wrap.append(oauthBox)
  setOauthUrl('')

  const importBtn = el('button', { className: 'primary', textContent: '导入服务器上的登录' })
  importBtn.onclick = async () => {
    try {
      state = await ctx.rpc.call('accounts.import-global', {})
      renderAccounts(); renderDefaultSelect()
      say('已从服务器全局登录导入')
      await refreshModels()
    } catch (e) { say(e.message, true) }
  }
  const addBtn = el('button', { textContent: '粘贴 token 添加' })
  addBtn.onclick = async () => {
    const token = tokenArea.value.trim()
    if (!token) return say('先粘贴 token 内容', true)
    try {
      state = await ctx.rpc.call('accounts.add', { token, ...(emailInput.value.trim() ? { email: emailInput.value.trim() } : {}) })
      tokenArea.value = ''
      emailInput.value = ''
      renderAccounts(); renderDefaultSelect()
      say('已添加账号')
      await refreshModels()
    } catch (e) { say(e.message, true) }
  }
  wrap.append(el('div', { className: 'line' }, importBtn, addBtn))
  wrap.append(el('div', { className: 'line' }, emailInput))
  wrap.append(tokenArea)

  // 3. 默认模型
  wrap.append(el('h2', { textContent: '默认模型' }))
  wrap.append(el('p', { className: 'hint', textContent: '新会话的默认模型；单个会话里可用 /agy-accounts:model <id> 覆盖。' }))
  const modelLine = el('div', { className: 'line' }, modelSelect)
  const saveBtn = el('button', { className: 'primary', textContent: '保存默认' })
  saveBtn.onclick = async () => {
    try {
      const r = await ctx.rpc.call('models.set-default', { model: modelSelect.value })
      say(r.syncedCount > 0 ? `默认模型已保存，已同步 ${r.syncedCount} 个反重力会话` : '默认模型已保存')
      await refreshModels()
    } catch (e) { say(e.message, true) }
  }
  const reloadBtn = el('button', { textContent: '刷新目录' })
  reloadBtn.onclick = async () => { await refreshModels(); say('模型目录已刷新') }
  modelLine.append(saveBtn, reloadBtn)
  wrap.append(modelLine)
  wrap.append(message)

  // ---------- 加载数据 ----------
  try {
    state = await ctx.rpc.call('accounts.list', {})
    renderAccounts()
    renderDefaultSelect()
    const settings = await ctx.rpc.call('settings.get', {})
    await refreshModels()
    if (settings.defaultModel) modelSelect.value = settings.defaultModel
    if (!state.accounts.length) say('还没有账号：点「导入服务器上的登录」或粘贴 token 添加')
  } catch (e) { say(`加载失败：${e.message}`, true) }
  await refreshEngine()

  return () => { root.replaceChildren() }
}
