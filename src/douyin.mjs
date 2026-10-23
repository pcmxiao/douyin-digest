/**
 * src/douyin.mjs —— 抖音的全部操作（搜索 / 详情 / 分享 / 私信）
 * ============================================================================
 * 全部通过 DOM 操作完成 —— 抖音没有可用的公开接口：
 *   · 搜索是前端渲染，DOM 里直接有数据
 *   · 消息走 ByteLink WebSocket（protobuf），HTTP 里没有
 *   · 分享/私信都是点击操作
 *
 * 🔴 每个按钮的点击方式都不一样（实测，别瞎改）：
 *   打开「消息」面板  → dispatchEvent
 *   打开分享面板      → Input.dispatchMouseEvent
 *   点「分享」按钮    → 先 hover，再 el.click()
 *   进聊天            → dispatchEvent
 *   发消息            → Input.insertText + Enter
 * ============================================================================
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 解析工具 ────────────────────────────────────────────────────

/** "11.7万" → 117000 */
export function parseCount(s) {
  const t = String(s || '').trim()
  const m = /^([\d.]+)\s*([万亿wkm]?)$/i.exec(t)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const u = (m[2] || '').toLowerCase()
  const mul = u === '万' || u === 'w' ? 1e4
    : u === '亿' ? 1e8
      : u === 'k' ? 1e3
        : u === 'm' ? 1e6 : 1
  return Math.round(n * mul)
}

/** "08:28" → 508 */
export function parseDuration(s) {
  const parts = String(s || '').trim().split(':').map(Number)
  if (parts.some((x) => !Number.isFinite(x))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/** "5小时前" / "10月16日" → ISO */
export function parseTime(s, now = new Date()) {
  const t = String(s || '').trim()
  if (!t) return ''
  let d = null
  let m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(t)
  if (m) {
    const n = Number(m[1])
    const u = m[2]
    const ms = u === '秒' ? n * 1000
      : u === '分钟' ? n * 60000
        : u === '小时' ? n * 3600000
          : n * 86400000
    d = new Date(now.getTime() - ms)
  } else if (t === '刚刚') d = now
  else if (t === '昨天') d = new Date(now.getTime() - 86400000)
  else if (t === '前天') d = new Date(now.getTime() - 2 * 86400000)
  else {
    m = /^(\d{1,2})月(\d{1,2})日$/.exec(t)
    if (m) {
      d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
      if (d > now) d.setFullYear(d.getFullYear() - 1)
    }
  }
  return d ? d.toISOString() : ''
}

// ── 搜索 ────────────────────────────────────────────────────────

/**
 * 搜索视频。
 *
 * ⭐ 卡片结构（实测）：
 *   容器 `.search-result-card`
 *   内部：时长 / 播放量 / 标题(字号最大) / 作者 / 时间
 *
 * 🔴 不要用纯文本正则切 —— 标题和描述会混在一起。
 *
 * @param {object} p { browser, keyword, limit }
 */
export async function search({ browser, keyword, limit = 20 }) {
  const kw = String(keyword || '').trim()
  if (!kw) return []

  await browser.goto(`https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`, { settleMs: 11000 })

  const gate = await browser.eval(`(() => {
    const t = document.body ? document.body.innerText : ''
    return { loginWall: /登录后即可搜索|请先登录|扫码登录/.test(t) }
  })()`)
  if (gate.loginWall) {
    const e = new Error('抖音搜索需要登录。先跑：douyin-digest login')
    e.code = 'NEEDS_LOGIN'
    throw e
  }

  const raw = await browser.eval(`(() => {
    const out = []
    let cards = [...document.querySelectorAll('.search-result-card')]
    if (!cards.length) {
      const seen = new Set()
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        let box = a
        for (let i = 0; i < 5 && box.parentElement; i++) {
          box = box.parentElement
          if (/\\d{1,2}:\\d{2}/.test(box.innerText || '')) break
        }
        if (!seen.has(box)) { seen.add(box); cards.push(box) }
      }
    }

    for (const card of cards) {
      const a = card.querySelector('a[href*="/video/"]')
      const m = a ? /\\/video\\/(\\d+)/.exec(a.getAttribute('href') || '') : null
      const id = m ? m[1] : ''

      const leaves = []
      for (const el of card.querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const t = (el.innerText || '').trim()
        if (!t) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        leaves.push({ text: t, y: Math.round(r.top), fontSize: parseFloat(getComputedStyle(el).fontSize) || 0 })
      }

      let duration = '', playText = '', timeText = '', author = ''
      const titleCand = []
      for (const l of leaves) {
        const t = l.text
        if (/^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test(t)) { duration = t; continue }
        // ⚠️ 播放量在时长之后，所以条件是「playText 没填」，不是「duration 没填」
        if (!playText && /^[\\d.]+[万亿]?$/.test(t) && t.length <= 6) { playText = t; continue }
        if (/^(\\d+\\s*(秒|分钟|小时|天)前|刚刚|昨天|前天|\\d{1,2}月\\d{1,2}日)$/.test(t)) { timeText = t; continue }
        if (t === '@') continue
        if (t.length <= 20 && !t.includes('#') && l.fontSize <= 14) { author = t; continue }
        titleCand.push(l)
      }

      titleCand.sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)
      const titleRaw = titleCand[0]?.text || ''
      const tags = [...titleRaw.matchAll(/#([^\\s#]+)/g)].map(x => x[1])
      const title = titleRaw.replace(/\\s*#[^\\s#]+/g, '').trim()

      if (!id && !title) continue
      out.push({ id, title, tags, author, duration, playText, timeText })
      if (out.length >= ${Math.max(limit * 2, 20)}) break
    }
    return out
  })()`)

  if (!Array.isArray(raw)) return []

  return raw.map((r) => ({
    platform: 'douyin',
    id: r.id,
    url: r.id ? `https://www.douyin.com/video/${r.id}` : '',
    title: r.title,
    author: r.author,
    tags: r.tags || [],
    durationSec: parseDuration(r.duration),
    play: parseCount(r.playText),
    publishedAt: parseTime(r.timeText),
  })).filter((c) => c.title).slice(0, limit)
}

// ── 详情 ────────────────────────────────────────────────────────

/**
 * 读视频详情：文案 + 话题 + 数据 + 评论。
 *
 * ⭐ 文案不是叶子元素 —— 正文和话题 `#xxx` 是分开的节点。
 *    做法：找左侧的话题 span，往上找父级直到长度合适。
 *
 * ⭐ 评论：`.Eh0a5CD4` 是单条容器，
 *    文本格式 `用户名 ▸ 内容 ▸ 时间·地区 ▸ 点赞 ▸ 分享 ▸ 回复`（换行分隔）
 */
export async function detail({ browser, id, commentLimit = 20 }) {
  const vid = String(id || '').trim()
  if (!vid) return { ok: false, error: '没有视频 id' }

  await browser.goto(`https://www.douyin.com/video/${vid}`, { settleMs: 11000 })
  try {
    await browser.eval('window.scrollBy(0, 500)')
    await sleep(2500)
  } catch { /* 滚不动算了 */ }

  const d = await browser.eval(`(() => {
    const out = { desc: '', tags: [], author: '', stats: {}, comments: [] }

    // ① 文案：从话题 span 往上找
    const hashSpans = []
    for (const el of document.querySelectorAll('span, a, div')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!t.startsWith('#') || t.length < 3) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.left > 1100) continue
      hashSpans.push({ el, y: r.top })
    }
    if (hashSpans.length) {
      hashSpans.sort((a, b) => a.y - b.y)
      let node = hashSpans[0].el
      for (let i = 0; i < 6 && node.parentElement; i++) {
        const t = (node.innerText || '').trim()
        if (t.length >= 20 && t.length <= 700 && t.includes('#')) { out.desc = t; break }
        node = node.parentElement
      }
      if (!out.desc) {
        const t = (node.innerText || '').trim()
        if (t.length <= 1000) out.desc = t
      }
    }
    // 兜底
    if (!out.desc) {
      let best = ''
      for (const el of document.querySelectorAll('div')) {
        if (el.children.length > 3) continue
        const t = (el.innerText || '').trim()
        if (t.length < 20 || t.length > 700 || !/[#@]/.test(t)) continue
        const r = el.getBoundingClientRect()
        if (r.left > 1100 || r.top > 750) continue
        if (t.length > best.length) best = t
      }
      out.desc = best
    }

    out.tags = [...out.desc.matchAll(/#([^\\s#@]+)/g)].map(m => m[1]).slice(0, 12)
    const am = /@([^\\s#@]+)/.exec(out.desc)
    if (am) out.author = am[1]

    // ② 统计：底部那排数字，左到右 = 赞 评 藏 分
    const nums = []
    const vh = innerHeight
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!/^[\\d.]+[万亿]?$/.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.top < vh * 0.55 || r.left > 1100) continue
      nums.push({ text: t, x: Math.round(r.left) })
    }
    nums.sort((a, b) => a.x - b.x)
    const keys = ['digg', 'comment', 'collect', 'share']
    nums.slice(0, 4).forEach((n, i) => { out.stats[keys[i]] = n.text })

    // ③ 评论
    const seen = new Set()
    for (const el of document.querySelectorAll('.Eh0a5CD4, [class*="CommentItem"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 300 || r.height < 50) continue
      const t = (el.innerText || '').trim()
      if (!t || t.length < 8) continue

      const lines = t.split('\\n').map(s => s.trim()).filter(Boolean)
      const user = lines[0] || ''
      const body = lines.slice(1).filter(l =>
        !/^(作者|置顶)$/.test(l)
        && !/^(\\d+\\s*(秒|分钟|小时|天)前|昨天|前天|\\d{1,2}月\\d{1,2}日)(\\s*·\\s*\\S+)?$/.test(l)
        && !/^\\d+$/.test(l)
        && !/^(分享|回复|展开\\d+条回复|收起)$/.test(l)
        && l !== '·' && l !== '...'
      )
      const text = body.join(' ').replace(/^[.．…]+\\s*/, '').trim()
      if (!text || text.length < 2) continue

      const key = (user + '|' + text).slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)

      const likeLine = lines.find(l => /^\\d+$/.test(l))
      out.comments.push({ user: user.slice(0, 30), text: text.slice(0, 200), like: likeLine ? Number(likeLine) : 0 })
      if (out.comments.length >= 30) break
    }

    return out
  })()`)

  return {
    ok: true,
    id: vid,
    url: `https://www.douyin.com/video/${vid}`,
    desc: String(d.desc || '').slice(0, 800),
    tags: d.tags || [],
    author: d.author || '',
    stats: Object.fromEntries(Object.entries(d.stats || {}).map(([k, v]) => [k, parseCount(v)])),
    comments: (d.comments || []).slice(0, commentLimit),
  }
}

// ── 分享 ────────────────────────────────────────────────────────

/** 分享面板开着吗 */
async function panelOpen(b) {
  return b.eval(`(() => {
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (/分享给朋友|复制链接/.test(el.innerText || '')) return true
    }
    return false
  })()`)
}

/** 某个好友那行变成「捎句话」= 分享成功 */
async function sharedTo(b, friendName) {
  return b.eval(`(() => {
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
      panel = el; break
    }
    if (!panel) return false
    const name = ${JSON.stringify(String(friendName || ''))}
    for (const el of panel.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      if ((el.innerText || '').trim() !== '捎句话') continue
      if (!name) return true
      let n = el
      for (let i = 0; i < 4 && n.parentElement; i++) {
        n = n.parentElement
        if ((n.innerText || '').includes(name)) return true
      }
    }
    return false
  })()`)
}

/**
 * 分享视频给互关好友。
 *
 * 🔴 成功判据不是"面板关闭"——**面板永远不关**。
 *    而是那个好友的按钮从「分享」变成「捎句话」。
 */
export async function share({ browser, id, to = '', dryRun = false }) {
  const vid = String(id || '').trim()
  if (!vid) return { ok: false, error: '没有视频 id' }

  await browser.goto(`https://www.douyin.com/video/${vid}`, { settleMs: 11000 })
  await browser.eval('window.scrollTo(0, 0)')
  await sleep(1200)

  // 找分享按钮（文字是播放数，如 "3.0万"）
  const pos = await browser.eval(`(() => {
    const el = document.querySelector('.sB3y0d3B')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.top < 0 || r.top > innerHeight) {
      el.scrollIntoView({ block: 'center' })
      const r2 = el.getBoundingClientRect()
      return { x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) }
    }
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)

  if (!pos) return { ok: false, error: '找不到分享按钮（页面结构可能变了）' }

  // 打开面板：必须用真实鼠标
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none' }, browser.sessionId)
  await sleep(300)
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await sleep(120)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await sleep(3000)

  if (!(await panelOpen(browser))) {
    return { ok: false, error: '分享面板没弹出（可能被风控）' }
  }

  // 找好友 + 分享按钮位置
  const btn = await browser.eval(`(() => {
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
      panel = el; break
    }
    if (!panel) return null
    const want = ${JSON.stringify(String(to || ''))}
    for (const el of panel.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      if ((el.innerText || '').trim() !== '分享') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      let rowText = ''
      let n = el
      for (let i = 0; i < 4 && n.parentElement; i++) {
        n = n.parentElement
        const s = (n.innerText || '').trim().replace(/\\n/g, ' ')
        if (s && s.length < 40 && s !== '分享') { rowText = s; break }
      }
      const friend = rowText.replace(/\\s*分享\\s*$/, '').trim()
      if (want && !friend.includes(want)) continue
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), friend }
    }
    return null
  })()`)

  if (!btn) return { ok: false, error: to ? `面板里没找到好友「${to}」` : '面板里没有「分享」按钮' }

  if (dryRun) {
    await closePanel(browser)
    return { ok: true, dryRun: true, friend: btn.friend }
  }

  // 点分享：先 hover，再 el.click()
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, button: 'none' }, browser.sessionId)
  await sleep(500)

  let ok = false
  for (let i = 0; i < 3; i++) {
    await browser.eval(`(() => {
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect()
        if (r.width < 150 || r.width > 700 || r.height < 100) continue
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
        if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
        for (const x of el.querySelectorAll('*')) {
          if (x.children.length > 0) continue
          if ((x.innerText || '').trim() !== '分享') continue
          if (x.getBoundingClientRect().width === 0) continue
          x.click()
          return true
        }
      }
      return false
    })()`)
    await sleep(2800)
    if (await sharedTo(browser, btn.friend)) { ok = true; break }
  }

  await closePanel(browser)
  return ok
    ? { ok: true, friend: btn.friend }
    : { ok: false, friend: btn.friend, error: '点了「分享」但按钮没变成「捎句话」' }
}

async function closePanel(b) {
  try {
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
  } catch { /* 忽略 */ }
}

// ── 私信 ────────────────────────────────────────────────────────

/**
 * 打开私信面板（toggle：开着就别再点）
 *
 * 🔴 踩过的坑：
 *   1. 「消息」按钮是 **toggle** —— 面板开着时再点会关掉
 *   2. 视频页**没有**「消息」按钮（在详情页跑 dm 会失败）
 *      ⇒ 先确认在首页，不在就导航过去
 */
async function ensurePanel(b) {
  // ① 先确保在能私信的页面（首页 / 搜索页 / 个人页都能，视频页不行）
  const where = await b.eval(`location.href`).catch(() => '')
  const canDM = /douyin\.com\/(jingxuan|$|\?|search|user)/.test(where) || where.endsWith('douyin.com/')
  if (!canDM) {
    await b.goto('https://www.douyin.com/', { settleMs: 8000 })
  }

  // ② 🔴 关键：视口必须够宽
  //    实测：窗口 1378 宽时，私信面板落在 x=1378（**完全在视口外**），点不到。
  //    ⚠️ `Emulation.setDeviceMetricsOverride` 不管用 —— 抖音的布局用它自己算的宽度，
  //       设了之后面板还是在外面。
  //    ⇒ 改成**调真实窗口大小**（Browser.setWindowBounds），布局会正确重算。
  const vp = await b.eval(`({ w: innerWidth, h: innerHeight })`).catch(() => null)
  if (vp && (vp.w < 1500 || vp.h < 850)) {
    try {
      const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
      await b.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: 1600, height: 950, windowState: 'normal' },
      })
      await sleep(2000)
    } catch (e) {
      // 拿不到窗口（可能是 headless / 某些平台）⇒ 退回 Emulation
      try {
        await b.send('Emulation.setDeviceMetricsOverride', {
          width: 1600, height: 950, deviceScaleFactor: vp.dpr || 1, mobile: false,
        }, b.sessionId)
        await sleep(1500)
      } catch { /* 都不行就继续，后面会报错 */ }
    }
  }

  // ③ 检查当前状态
  const st = await b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter((x) => x.getBoundingClientRect().width > 100)
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width >= 250 && r.width <= 600 && r.height >= 300) {
        const t = el.innerText || ''
        if (t.includes('消息') && /分钟前|小时前|昨天|刚刚|\\d+月\\d+日/.test(t)) { panel = el; break }
      }
    }
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    const hasMsgBtn = [...document.querySelectorAll('*')].some(
      (el) => (el.innerText || '').trim() === '消息' && el.children.length === 0 && el.getBoundingClientRect().width > 0,
    )
    const pr = panel ? panel.getBoundingClientRect() : null
    return {
      inChat,
      panelOpen: Boolean(panel),
      hasMsgBtn,
      vw: innerWidth,
      vh: innerHeight,
      panelRect: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right) } : null,
      offscreen: pr ? (pr.left < 0 || pr.right > innerWidth) : false,
    }
  })()`)

  if (st.inChat) return st

  // 🔴 只要面板开着就认 —— **不管在不在视口内**。
  //    因为 dispatchEvent 不需要坐标在视口内。
  //    ⚠️ 而且「消息」是 toggle：面板开着时再点会**关掉**。
  //       之前我加了 `&& !st.offscreen`，导致视口外的面板不被认，
  //       然后又点了一次 → 把开着的面板关掉了 → 永远打不开。
  if (st.panelOpen) return st

  // ⑤ 面板没开（或者还在视口外）：点「消息」
  if (!st.hasMsgBtn) {
    return { ...st, error: '当前页面没有「消息」按钮' }
  }

  await b.eval(`(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === '消息' && el.children.length === 0) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        return true
      }
    }
    return false
  })()`)
  await sleep(3000)

  return b.eval(`(() => {
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width >= 250 && r.width <= 600 && r.height >= 300) {
        const t = el.innerText || ''
        if (t.includes('消息') && /分钟前|小时前|昨天|刚刚/.test(t)) {
          const rr = el.getBoundingClientRect()
          return {
            inChat: false, panelOpen: true, hasMsgBtn: true,
            vw: innerWidth, vh: innerHeight,
            panelRect: { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height), right: Math.round(rr.right) },
            offscreen: rr.left < 0 || rr.right > innerWidth,
          }
        }
      }
    }
    return { inChat: false, panelOpen: false, hasMsgBtn: true, vw: innerWidth, vh: innerHeight, error: '面板没打开' }
  })()`)
}

/**
 * 进聊天界面。
 *
 * ⭐ 用语义化 class 定位（比坐标可靠）：
 *    `conversationConversationItemwrapper`  = 一个会话项（324×67）
 *       ├ `conversationConversationItemrowArea1`  头像区
 *       ├ `conversationConversationItemtitle`     好友名
 *       ├ `ConversationItemTagNextToTitlewrapper` 时间
 *       └ `ConversationItemDescwrapper`           消息预览
 *
 * 🔴 踩过的坑：
 *   1. 点外层容器 / 叶子都可能没反应 ⇒ **要试多层**
 *   2. 面板在窄窗口下会 `translateX(100%)` 滑出视口
 *      ⇒ dispatchEvent 可以，Input 不行
 *   3. 之前"找第一个含时间的元素"会命中嵌套内层，导致进错会话
 */
async function enterChat(b, uname = '') {
  const result = await b.eval(`(() => {
    // ⭐ 直接用会话项 class
    let items = [...document.querySelectorAll('[class*="ConversationItemwrapper"]')]
    if (!items.length) {
      // 兜底：按尺寸和内容找
      const KW = ['分钟前', '小时前', '昨天', '刚刚']
      items = [...document.querySelectorAll('div')].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.width > 450) return false
        if (r.height < 50 || r.height > 120) return false
        const t = el.innerText || ''
        return KW.some(k => t.indexOf(k) >= 0)
      })
    }
    if (!items.length) return { err: 'no conversation items' }

    // 解析每个会话项
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const t = (el.innerText || '').trim()
      const nameEl = el.querySelector('[class*="ConversationItemtitle"]')
      const timeEl = el.querySelector('[class*="TagNextToTitle"]')
      const descEl = el.querySelector('[class*="ConversationItemDesc"]')
      return {
        el,
        y: Math.round(r.top),
        name: (nameEl?.innerText || '').trim() || (t.split(String.fromCharCode(10)).filter(Boolean)[0] || ''),
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split(String.fromCharCode(10)).join(' '),
      }
    }).filter((x) => x.name)

    if (!rows.length) return { err: 'no named rows' }
    rows.sort((a, b) => a.y - b.y)

    const want = ${JSON.stringify(String(uname || ''))}
    let target = rows[0]
    if (want) {
      const hit = rows.find(r => r.name.includes(want))
      if (!hit) return { err: 'not found', available: rows.map(r => r.name) }
      target = hit
    }

    // 🔴 多层点击（某些层级的事件是分开绑的）
    const fire = (el) => {
      if (!el) return
      const o = { bubbles: true, cancelable: true, view: window }
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
      try { el.click() } catch (e) {}
    }

    // 点 wrapper、它的父级、它的内容区
    fire(target.el)
    fire(target.el.parentElement)
    fire(target.el.querySelector('[class*="rowArea2"]'))
    fire(target.el.querySelector('[class*="ConversationItemDesc"]'))

    return { ok: true, name: target.name, total: rows.length, all: rows.map(r => r.name) }
  })()`)

  if (result.err) {
    if (result.err === 'not found') {
      throw new Error(`找不到会话「${uname}」，现有：${(result.available || []).join(', ')}`)
    }
    return false
  }

  await sleep(3000)
  if (await hasInput(b)) return true

  // 再点一次（第二下常有效）
  await b.eval(`(() => {
    const WANT = ${JSON.stringify(String(uname || ''))}
    let items = [...document.querySelectorAll('[class*="ConversationItemwrapper"]')]
    if (!items.length) return false
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const nameEl = el.querySelector('[class*="ConversationItemtitle"]')
      return { el, y: Math.round(r.top), name: (nameEl?.innerText || '').trim() }
    }).filter(x => x.name).sort((a, b) => a.y - b.y)
    if (!rows.length) return false
    let t = rows[0]
    if (WANT) t = rows.find(r => r.name.includes(WANT)) || rows[0]
    t.el.click()
    return true
  })()`)
  await sleep(3000)

  return hasInput(b)
}

/** 聊天输入框出现了吗 */
async function hasInput(b) {
  return b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter(x => x.getBoundingClientRect().width > 100)
    return Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
  })()`)
}

/**
 * 读私信（进聊天界面，读 DOM）。
 * @param {object} p { browser, limit }
 */
/**
 * 读私信消息（带发送者标记）。
 *
 * ⭐ 判断"谁发的"用 class **`isFromMe`**（探针实测）：
 *    每条消息的外层容器是 `messageMessageBoxmessageBox`，
 *    内层 `messageMessageBoxcontentBox` 上如果是自己发的就带 `isFromMe`。
 *
 * ⚠️ **抖音是虚拟列表**：默认只渲染最近的一屏。想读更多历史必须往上滚。
 *    `scrollBack` 控制往上滚几次（每次约加载 20 条）。滚完再读。
 *
 * ⚠️ 分享卡片是 `MessageItemShareAwemecontainer`，文本只有作者名，没有正文。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {number} p.limit       最多返回多少条（默认 30）
 * @param {string} p.uname       指定会话（按好友名），空=最新的
 * @param {number} p.scrollBack  往上滚几次来加载历史（默认 0，不滚）
 */
export async function readDM({ browser, limit = 30, uname = '', scrollBack = 0 }) {
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return {
      ok: false,
      error: st.error || '打不开私信面板',
      debug: { vw: st.vw, vh: st.vh, hasMsgBtn: st.hasMsgBtn, panelRect: st.panelRect },
    }
  }

  // 指定了好友，或者还没进聊天 → 进会话
  if (!st.inChat || uname) {
    let entered = false
    try {
      entered = await enterChat(browser, uname)
    } catch (e) {
      return { ok: false, error: e.message, debug: st }
    }
    if (!entered) {
      return { ok: false, error: '进不去具体会话（点了但没出现输入框）', debug: st }
    }
  }

  // 往上滚加载历史
  if (scrollBack > 0) {
    for (let i = 0; i < scrollBack; i++) {
      const before = await browser.eval(`(() => {
        const boxes = document.querySelectorAll('div[class*="messageMessageBox"]').length
        return boxes
      })()`)
      await browser.eval(`(() => {
        // 找最大的可滚动容器（消息列表）
        let best = null
        let bestArea = 0
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight <= el.clientHeight + 20) continue
          const r = el.getBoundingClientRect()
          if (r.width < 200 || r.height < 150) continue
          const area = r.width * r.height
          if (area > bestArea) { bestArea = area; best = el }
        }
        if (best) {
          best.scrollTop = 0
          return { ok: true, h: best.clientHeight, sh: best.scrollHeight }
        }
        return { ok: false }
      })()`)
      await sleep(1500)
      const after = await browser.eval(`(() => {
        return document.querySelectorAll('div[class*="messageMessageBox"]').length
      })()`)
      if (after <= before) break   // 没加载出新东西，停
    }
  }

  const msgs = await browser.eval(`(() => {
    // 找所有消息外层容器
    const all = [...document.querySelectorAll('div[class*="messageMessageBox"]')]
    const boxes = all.filter((el) => {
      const cls = (el.className || '').toString()
      if (!cls.includes('messageBox')) return false
      if (cls.includes('selectableRow')) return false
      if (cls.includes('contentBox')) return false
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })

    const out = []
    for (const box of boxes) {
      const t = (box.innerText || '').trim()
      if (!t) continue
      const r = box.getBoundingClientRect()

      // ⭐ 判断发送者
      const fromMe = Boolean(box.querySelector('[class*="isFromMe"]'))
      // 是不是分享卡片
      const isShare = Boolean(box.querySelector('[class*="MessageItemShareAweme"]'))

      // 清理文本
      const lines = t.split(String.fromCharCode(10))
        .map((s) => s.replace(/\\u200b/g, '').trim())
        .filter(Boolean)
        .filter((s) => !/^(\\d+\\s*(秒|分钟|小时|天)前|刚刚|昨天|前天|\\d{1,2}月\\d{1,2}日)$/.test(s))

      const text = lines.join(' ').trim()
      if (!text) continue

      out.push({
        fromMe,
        isShare,
        text: text.slice(0, 500),
        // ⭐ y 坐标用于排序（DOM 顺序不可靠）
        y: Math.round(r.top),
      })
    }
    return out
  })()`)

  if (!Array.isArray(msgs)) return { ok: false, error: '读不到消息列表', debug: st }

  // 去重（嵌套容器会重复）
  const seen = new Set()
  const uniq = msgs.filter((m) => {
    const k = (m.fromMe ? 'me' : 'peer') + '|' + m.text.slice(0, 40)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // ⭐ 按 y 排序 = 视觉顺序（从上到下），最后一条就是最新的
  uniq.sort((a, b) => a.y - b.y)

  // 标记系统消息（不该触发回复）
  const SYS = /已互相关注|可以开始聊天|发布了新作品|进入了直播间|关注了你|赞了你的|系统消息|撤回了一条消息/
  for (const m of uniq) {
    m.system = !m.isShare && SYS.test(m.text)
    delete m.y
  }

  return {
    ok: true,
    messages: uniq.slice(-limit),
    total: uniq.length,
    inChat: true,
  }
}

/**
 * 发私信。
 * @param {object} p { browser, text, uname }
 */
export async function sendDM({ browser, text, uname = '' }) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '正文是空的' }

  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) return { ok: false, error: '打不开私信面板' }
  if (!st.inChat) await enterChat(browser, uname)

  const focused = await browser.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)
  if (!focused) return { ok: false, error: '找不到输入框' }

  // 点一下输入框，确保焦点
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await sleep(400)

  await browser.send('Input.insertText', { text: body }, browser.sessionId)
  await sleep(1000)

  const typed = await browser.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    return el ? (el.value || el.innerText || '') : ''
  })()`)

  if (!typed.trim()) return { ok: false, error: '输入没生效' }

  // Enter 发送
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await sleep(2500)

  const after = await browser.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    return el ? (el.value || el.innerText || '').replace(/\\u200b/g, '').trim() : ''
  })()`)

  return after
    ? { ok: false, error: '输入框还有内容，可能没发出去' }
    : { ok: true }
}

/** 登录态检查 */
export async function checkLogin(browser) {
  const ck = await browser.cookies(['https://www.douyin.com/', 'https://www.douyin.com/user/self'])
  const names = ck.map((c) => c.name)
  // ⚠️ 只认 sessionid / sessionid_ss —— passport_csrf_token 是访客 cookie
  const logged = names.includes('sessionid') || names.includes('sessionid_ss')
  return {
    loggedIn: logged,
    cookies: names.length,
    detail: logged ? '已登录' : '未登录（passport_csrf_token 是访客 cookie，不算登录）',
  }
}
