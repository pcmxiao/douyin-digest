/**
 * src/digest.mjs —— 完整一轮：搜 → 读 → 打分 → 日报 → 分享
 * ============================================================================
 * 这是 CLI 的主流程。
 * ============================================================================
 */
import { search, detail, share } from './douyin.mjs'
import { score, composeContent } from './score.mjs'
import { Seen, dayKey, paths, ensureHome } from './config.mjs'
import { writeFileSync } from 'node:fs'

/**
 * 跑一轮。
 * @param {object} p
 * @param {object} p.browser
 * @param {string[]} p.keywords     关键词
 * @param {number} p.searchLimit    每个词搜多少条
 * @param {number} p.readLimit      读几条详情
 * @param {number} p.topN           挑几条
 * @param {boolean} p.doReport      写日报
 * @param {boolean} p.doShare       分享
 * @param {boolean} p.dryRun        只看不做
 * @param {string} p.shareTo        分享给谁（空=第一个好友）
 * @param {function} p.onLog        日志
 */
export async function runRound({
  browser,
  keywords = [],
  searchLimit = 20,
  readLimit = 3,
  topN = 3,
  doReport = false,
  doShare = false,
  dryRun = true,
  shareTo = '',
  onLog = () => {},
}) {
  ensureHome()
  const log = onLog
  const seen = new Seen()
  const result = {
    keywords,
    candidates: 0,
    fresh: 0,
    read: 0,
    picked: [],
    errors: [],
    reportPath: '',
    shared: [],
  }

  // ── ① 搜索 ────────────────────────────────────────────────────
  log('① 搜索')
  let all = []
  for (const kw of keywords) {
    try {
      const list = await search({ browser, keyword: kw, limit: searchLimit })
      log(`   「${kw}」→ ${list.length} 条`)
      all.push(...list)
    } catch (e) {
      result.errors.push(`搜索「${kw}」失败：${e.message}`)
      log(`   ❌ 「${kw}」：${e.message}`)
      if (e.code === 'NEEDS_LOGIN') return result
    }
  }

  // 去重（同一条可能被多个关键词命中）
  const byId = new Map()
  for (const c of all) {
    if (!c.id) continue
    if (!byId.has(c.id)) byId.set(c.id, c)
  }
  let uniq = [...byId.values()]
  result.candidates = uniq.length
  log(`   合计 ${uniq.length} 条（去重后）`)

  // ── ② 判重 ────────────────────────────────────────────────────
  const fresh = uniq.filter((c) => !seen.has(c.id))
  result.fresh = fresh.length
  log(`② 判重：${uniq.length} → ${fresh.length}（${uniq.length - fresh.length} 条看过）`)

  if (!fresh.length) {
    log('   没有新内容，结束')
    return result
  }

  // ── ③ 粗排（不读详情）─────────────────────────────────────────
  const rough = fresh
    .map((c) => ({ c, ...score(c, null, { keywords }) }))
    .sort((a, b) => b.score - a.score)

  log('③ 粗排前 5:')
  for (const r of rough.slice(0, 5)) {
    log(`   ${String(r.score).padStart(4)}  ${r.c.title.slice(0, 40)}`)
  }

  // ── ④ 读详情（最贵的一步，只读前 N 条）─────────────────────────
  let enriched = rough
  if (readLimit > 0) {
    log(`④ 读详情（前 ${readLimit} 条）`)
    enriched = []
    for (let i = 0; i < Math.min(readLimit, rough.length); i++) {
      const { c } = rough[i]
      log(`   [${i + 1}/${Math.min(readLimit, rough.length)}] ${c.title.slice(0, 30)}…`)
      try {
        const d = await detail({ browser, id: c.id, commentLimit: 15 })
        const s = score(c, d, { keywords })
        const content = composeContent(d)
        enriched.push({ c, ...s, detail: d, content })
        log(`       → ${content.kind} ${content.text.length} 字，分 ${s.score}`)
        result.read++
      } catch (e) {
        enriched.push({ c, ...score(c, null, { keywords }), detail: null, content: { kind: 'none', text: '', note: e.message } })
        log(`       → 失败: ${e.message}`)
        result.errors.push(`读 ${c.id} 失败：${e.message}`)
      }
    }
    enriched.sort((a, b) => b.score - a.score)
  }

  // ── ⑤ 挑 ──────────────────────────────────────────────────────
  const picked = enriched.slice(0, topN)
  result.picked = picked.map((p) => ({
    id: p.c.id,
    title: p.c.title,
    author: p.c.author,
    url: p.c.url,
    score: p.score,
    tier: p.tier,
    reasons: p.reasons,
    contentKind: p.content?.kind || 'none',
  }))

  log(`⑤ 挑中 ${picked.length} 条:`)
  for (const p of picked) {
    log(`   [${p.tier}] ${p.score} 分  ${p.c.title.slice(0, 40)}`)
  }

  // ── ⑥ 日报 ────────────────────────────────────────────────────
  if (doReport && !dryRun) {
    const md = renderReport({ picked, keywords, candidates: result.candidates, fresh: result.fresh })
    const f = paths.report(dayKey())
    writeFileSync(f, md, 'utf8')
    result.reportPath = f
    log(`⑥ 日报已写：${f}`)
  } else if (doReport && dryRun) {
    log('⑥ 日报：[dry-run] 不写文件')
  }

  // ── ⑦ 分享 ────────────────────────────────────────────────────
  if (doShare) {
    log(`⑦ 分享${dryRun ? '（dry-run）' : ''}`)
    for (const p of picked) {
      try {
        const r = await share({ browser, id: p.c.id, to: shareTo, dryRun })
        if (r.ok) {
          log(`   ✅ ${p.c.title.slice(0, 25)} → ${r.friend}`)
          result.shared.push({ id: p.c.id, friend: r.friend })
          if (!dryRun) seen.add(p.c.id, p.c.title)
        } else {
          log(`   ❌ ${p.c.title.slice(0, 25)}：${r.error}`)
          result.errors.push(`分享 ${p.c.id}：${r.error}`)
        }
        await new Promise((x) => setTimeout(x, 1500))
      } catch (e) {
        log(`   ❌ ${e.message}`)
        result.errors.push(`分享 ${p.c.id}：${e.message}`)
      }
    }
  }

  // ── ⑧ 记账 ────────────────────────────────────────────────────
  if (!dryRun) {
    for (const p of picked) seen.add(p.c.id, p.c.title)
  } else {
    log('⑧ 判重表：[dry-run] 不记账')
  }

  return result
}

/** 渲染日报 markdown */
export function renderReport({ picked, keywords, candidates, fresh }) {
  const lines = []
  lines.push(`# 抖音精选 · ${dayKey()}`)
  lines.push('')
  lines.push(`> 关键词：${keywords.map((k) => `「${k}」`).join(' ')}`)
  lines.push(`> 候选 ${candidates} → 判重 ${fresh} → 挑 ${picked.length}`)
  lines.push('')

  for (const p of picked) {
    lines.push(`### douyin:${p.c.id}`)
    lines.push(`- 标题：${p.c.title}`)
    lines.push(`- 作者：@${p.c.author || '?'}　时长：${fmtDur(p.c.durationSec)}　播放：${p.c.play}`)
    lines.push(`- 链接：${p.c.url}`)
    lines.push(`- **档位**：${p.tier}`)
    lines.push(`- 得分：${p.score}${p.reasons?.length ? `（${p.reasons.join('、')}）` : ''}`)
    lines.push(`- 内容形态：${p.content?.kind || 'none'}`)
    if (p.detail?.stats) {
      const s = p.detail.stats
      lines.push(`- 数据：赞 ${s.digg || 0} · 评 ${s.comment || 0} · 藏 ${s.collect || 0} · 分 ${s.share || 0}`)
    }
    lines.push('')
    if (p.content?.text) {
      lines.push('```')
      lines.push(p.content.text.slice(0, 1500))
      lines.push('```')
      lines.push('')
    }
  }

  if (!picked.length) {
    lines.push('_今天没有挑中的内容。_')
  }

  return lines.join('\n')
}

function fmtDur(sec) {
  const s = Number(sec) || 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
