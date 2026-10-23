/**
 * src/score.mjs —— 打分：哪些视频值得看
 * ============================================================================
 * 这是「精选」的核心。不是按播放量排（那样全是娱乐），而是综合判断：
 *
 *   · **关键词命中**（+40）：你关心的主题，最强信号
 *   · **知识类信号**（+10/个，上限30）：AI/编程/开源/教程…
 *   · **娱乐类降权**（-15/个，下限-45）：番剧/整活/鬼畜/吃播…
 *   · **互动率**（上限40）：点赞/播放，比播放量本身可靠
 *   · **时长**（±15）：30秒-5分钟最佳
 *   · **评论质量**（上限20）：有实质讨论的比纯表情好
 *
 * ⚠️ 这只是粗排 —— 真正的"值不值得"应该由模型判断（这是 bili-scroll 的思路）。
 *    但在没有模型的情况下，这套启发式已经能过滤掉大部分噪音。
 * ============================================================================
 */

const KNOWLEDGE = [
  'DeepSeek', 'AI', '人工智能', '大模型', 'LLM', 'GPT', 'Claude', 'Agent',
  '开源', '推理', '模型', '编程', '代码', '开发', '架构', '算法', '工程',
  '教程', '原理', '详解', '分析', '深度', '拆解', '科普', '数学', '物理',
  '设计', '产品', '效率', '工具', '论文', '研究', '技术', '框架',
]

const ENTERTAINMENT = [
  '番剧', '整活', '鬼畜', '搞笑', '沙雕', '挑战', '开箱', '吃播', '美食',
  '游戏', '手游', '抽卡', '攻略', '直播', '切片', '合集', '混剪', '动画',
  '漫画', '手书', '剧情', '恋爱', '搞笑视频', '沙雕动画', '解压',
]

/**
 * 给一个候选打分。
 * @param {object} c      搜索结果的候选
 * @param {object} detail 详情（可选，有的话打得更准）
 * @param {object} opts   { keywords }
 * @returns {{score:number, tier:string, reasons:string[]}}
 */
export function score(c, detail = null, opts = {}) {
  const keywords = (opts.keywords || []).filter(Boolean)
  const hay = [
    c.title || '',
    (c.tags || []).join(' '),
    detail?.desc || '',
  ].join(' ')

  let s = 0
  const reasons = []

  // ① 播放量：对数，避免爆款碾压
  const play = Number(c.play) || 0
  if (play > 0) {
    const ps = Math.log10(play) * 8
    s += ps
  }

  // ② 关键词命中（最强信号）
  let kwHit = 0
  for (const kw of keywords) {
    if (hay.toLowerCase().includes(String(kw).toLowerCase())) kwHit++
  }
  if (kwHit) {
    s += Math.min(kwHit * 40, 80)
    reasons.push(`命中关键词 ×${kwHit}`)
  }

  // ③ 知识类信号
  let know = 0
  for (const w of KNOWLEDGE) if (hay.includes(w)) know++
  if (know) {
    s += Math.min(know * 10, 30)
    reasons.push(`知识类 ×${know}`)
  }

  // ④ 娱乐类降权
  let ent = 0
  for (const w of ENTERTAINMENT) if (hay.includes(w)) ent++
  if (ent) {
    s -= Math.min(ent * 15, 45)
    reasons.push(`娱乐类 ×${ent}（降权）`)
  }

  // ⑤ 互动率
  //
  // 🔴 这里踩过一个坑：详情页抓的 `digg` 有时会等于搜索结果里的 `play`
  //    （抖音视频页底部那排数字里，"赞"的位置会随布局变，偶尔抓到播放量）。
  //    结果算出"互动率 100%"，明显不合理。
  //    ⇒ 加合理性检查：互动率 > 50% 说明数据可疑，不给分。
  //    ⇒ 改用**评论率**（评论数/播放）作为主指标 —— 它更可靠，也更反映真实讨论。
  if (play > 0 && detail?.stats) {
    const digg = Number(detail.stats.digg) || 0
    const cmt = Number(detail.stats.comment) || 0

    // 评论率：1% 已经算高互动
    if (cmt > 0) {
      const cr = cmt / play
      const cs = Math.min(cr * 4000, 30)
      if (cs > 5) reasons.push(`评论率 ${(cr * 100).toFixed(2)}%`)
      s += cs
    }

    // 点赞率：只在数据合理时才用
    if (digg > 0) {
      const lr = digg / play
      if (lr > 0 && lr <= 0.5) {
        s += Math.min(lr * 600, 25)
        if (lr > 0.05) reasons.push(`点赞率 ${(lr * 100).toFixed(1)}%`)
      }
      // lr > 0.5 ⇒ 数据可疑（digg 大概是播放量），跳过
    }
  }

  // ⑥ 时长
  const dur = Number(c.durationSec) || 0
  if (dur >= 30 && dur <= 300) {
    s += 15
  } else if (dur > 600) {
    s -= 10
    reasons.push('太长')
  }

  // ⑦ 评论质量
  if (detail?.comments?.length) {
    const subst = detail.comments.filter((x) => x.text.length > 15).length
    const cs = Math.min(subst * 3, 20)
    s += cs
    if (subst >= 3) reasons.push(`有 ${subst} 条实质评论`)
  }

  const final = Math.round(s)
  // 档位：这三个词是固定的（宿主/日报按它筛选）
  const tier = final >= 110 ? '值得看' : final >= 70 ? '可以看' : '不值当'

  return { score: final, tier, reasons }
}

/** 把详情拼成"给模型看的原文" */
export function composeContent(detail) {
  if (!detail?.ok) return { kind: 'none', text: '', note: detail?.error || '取不到' }

  const parts = []

  if (detail.desc) {
    parts.push('【文案】')
    parts.push(detail.desc)
    parts.push('')
  }

  if (detail.tags?.length) {
    parts.push('【话题】' + detail.tags.map((t) => '#' + t).join(' '))
    parts.push('')
  }

  if (detail.comments?.length) {
    parts.push(`【评论 ${detail.comments.length} 条】`)
    for (const c of detail.comments.slice(0, 20)) {
      const like = c.like ? `（${c.like} 赞）` : ''
      parts.push(`${c.user ? c.user + '：' : ''}${c.text}${like}`)
    }
    parts.push('')
  }

  const st = detail.stats || {}
  if (Object.keys(st).length) {
    parts.push(`【数据】赞 ${st.digg || 0} · 评论 ${st.comment || 0} · 收藏 ${st.collect || 0} · 分享 ${st.share || 0}`)
  }

  const text = parts.join('\n').trim()

  return {
    kind: detail.comments?.length ? 'desc+comments' : (detail.desc ? 'desc' : 'none'),
    text,
    note: detail.comments?.length
      ? `文案 + ${detail.comments.length} 条评论（抖音无字幕轨，语音需另做转写）`
      : '只读到文案（没拿到评论）',
  }
}
