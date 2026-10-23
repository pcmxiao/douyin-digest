/**
 * src/watch.mjs —— 私信自动回复（AI 模拟真人聊天）
 * ============================================================================
 * 流程：
 *   ① 每 N 秒读一次私信
 *   ② 找**对方发的、最新的、还没回过的**那条
 *   ③ 生成回复（三种方式：回显 / 调 API / 调外部命令）
 *   ④ 发出去
 *
 * 🔴 安全闸（都写死在代码里）：
 *   · **只回对方发的**，不回自己发的（否则会自己跟自己聊）
 *   · **每条只回一次**（记住最后回复的那条的指纹）
 *   · **每天有上限**（默认 50 条，防止失控）
 *   · **分享卡片默认不回**（那是视频卡片，不是对话）
 *
 * ⚠️ 抖音私信没有 HTTP 接口，全靠 DOM。所以：
 *   · 每轮都要重新进聊天界面（约 5-10 秒）
 *   · 浏览器必须开着
 * ============================================================================
 */
import { readDM, sendDM } from './douyin.mjs'
import { readJson, writeJson, paths } from './config.mjs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 消息指纹（用于判重） */
function fingerprint(msg) {
  const s = (msg.fromMe ? 'me' : 'peer') + '|' + String(msg.text || '').slice(0, 80)
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * 生成回复。
 * @param {object} p
 * @param {string} p.text      最新一条消息
 * @param {Array}  p.history   最近的对话（[{fromMe, text}]）
 */
export async function generateReply({
  mode = 'echo',
  text,
  history = [],
  persona = '',
  apiKey = '',
  apiBase = 'https://api.deepseek.com',
  model = '',
  replyCmd = '',
  log = () => {},
}) {
  // ① 回显（测试用）
  if (mode === 'echo') {
    return `收到：${text}`
  }

  /**
   * ⭐ 统一的上下文规格：**标准 LLM messages 数组**。
   *
   *   messages = [
   *     { role: 'user',      content: '你好' },      // 对方
   *     { role: 'assistant', content: '嗨，怎么啦？' }, // 我
   *     { role: 'user',      content: '还可以' },      // 待回复
   *   ]
   *
   *   · system prompt 由回复引擎自己加（人设归引擎管，不归 watch 管）
   *   · `history` 里 `fromMe: true` → assistant，`false` → user
   *
   * 外部命令通过 stdin 收到这段 JSON（`{ messages, persona, model }`），
   * 不再拼成"对方：xxx"的文本 —— 那样引擎还得反解析，容易错。
   */
  const messages = [
    ...history
      .filter((m) => m && m.text)
      .map((m) => ({ role: m.fromMe ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: text },
  ]

  // ② 外部命令
  //    stdin: JSON { messages, persona, model }
  //    stdout: 回复正文
  if (mode === 'cmd' && replyCmd) {
    const { spawn } = await import('node:child_process')
    const payload = JSON.stringify({ messages, persona: persona || '', model: model || '' }, null, 2)

    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32'
      const child = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', replyCmd] : ['-c', replyCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (b) => { out += String(b) })
      child.stderr.on('data', (b) => { err = (err + String(b)).slice(-400) })
      const t = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, 90000)
      child.on('exit', (code) => {
        clearTimeout(t)
        if (code !== 0) return reject(new Error(`回复命令失败（code=${code}）：${err.slice(-200)}`))
        resolve(out.trim())
      })
      child.on('error', (e) => { clearTimeout(t); reject(e) })
      child.stdin.write(payload)
      child.stdin.end()
    })
  }

  // ③ 直接调 API（OpenAI 兼容）
  if (mode === 'api' && apiKey) {
    const sys = persona || '你在用抖音私信跟朋友聊天。回复要短，一到两句，口语化，不要用 markdown，不要加"回复："之类的前缀。'
    const res = await fetch(`${apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, ...messages],
        max_tokens: 200,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`API ${res.status}：${t.slice(0, 200)}`)
    }
    const j = await res.json()
    let reply = String(j?.choices?.[0]?.message?.content || '').trim()
    reply = reply
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/^(回复|回答)[:：]\s*/, '')
      .replace(/\*\*/g, '')
      .trim()
    return reply
  }

  throw new Error('没有可用的回复方式（mode=' + mode + '）')
}

/**
 * 跑 watch 循环。
 * @param {object} p
 * @param {object} p.browser
 * @param {number} p.intervalSec   轮询间隔（秒）
 * @param {number} p.maxPerDay     每天最多回几条
 * @param {number} p.contextChars  上下文预算（字符）。中文粗估 1 字 ≈ 1.2~1.5 token，
 *                                 所以 600000 字符约 800k token，给 1M 窗口留余量。
 * @param {object} p.replyOptions  传给 generateReply 的参数
 * @param {boolean} p.dryRun       只打印不发送
 * @param {number} p.maxRounds     跑几轮就停（0=不限）
 * @param {function} p.onEvent     事件回调 {type, ...}
 */
export async function runWatch({
  browser,
  intervalSec = 30,
  maxPerDay = 50,
  contextChars = 600000,
  replyOptions = {},
  dryRun = false,
  maxRounds = 0,
  onEvent = () => {},
}) {
  const stateFile = join(paths.home, 'watch-state.json')
  const state = readJson(stateFile, { lastFingerprint: '', day: '', count: 0, replyTo: '' })
  const today = new Date().toISOString().slice(0, 10)

  // 跨天重置计数
  if (state.day !== today) {
    state.day = today
    state.count = 0
    writeJson(stateFile, state)
  }

  let rounds = 0
  let stopped = false

  const stop = () => { stopped = true }

  while (!stopped) {
    rounds++
    try {
      // ⚠️ limit 只是上限 —— 实际能读多少由抖音的 DOM 决定（见 readDM 注释）
      const dm = await readDM({ browser, limit: 500 })

      if (!dm.ok) {
        onEvent({ type: 'error', error: dm.error })
      } else {
        // 找对方发的、非卡片、非系统消息的最后一条
        const peerMsgs = dm.messages.filter((m) => !m.fromMe && !m.isShare && !m.system && m.text.trim())
        const lastPeer = peerMsgs[peerMsgs.length - 1]
        if (!lastPeer) {
          onEvent({ type: 'idle', reason: '没有对方发的消息' })
        } else {
          const fp = fingerprint(lastPeer)
          if (fp === state.lastFingerprint) {
            onEvent({ type: 'idle', reason: '没有新消息' })
          } else if (state.count >= maxPerDay) {
            onEvent({ type: 'limit', reason: `今天已回 ${state.count} 条，达到上限 ${maxPerDay}` })
          } else {
            // 有新消息 → 生成回复（带上下文）
            onEvent({ type: 'received', text: lastPeer.text })

            /**
             * 上下文：**按字符预算从最新往旧累加**，不按条数砍。
             *
             * 🔴 早先写死 `slice(-9, -1)`（只给 8 条），那是错的 ——
             *    M3.1-Flash 有 1M 窗口，8 条是极大的浪费。
             *    正确做法是吃满预算，让模型自己决定用哪些。
             *
             * 去掉末尾那条待回复的（它单独作为 text 传）。
             */
            const clean = dm.messages.filter((m) => !m.system && !m.isShare && m.text.trim())
            const before = clean.slice(0, -1)   // 不含待回复的那条

            const ctx = []
            let budget = contextChars
            for (let i = before.length - 1; i >= 0; i--) {
              const m = before[i]
              const len = String(m.text).length
              if (len > budget) break
              budget -= len
              ctx.unshift(m)
            }

            const truncated = ctx.length < before.length
            if (ctx.length > 8 || truncated) {
              onEvent({
                type: 'context',
                used: ctx.length,
                total: before.length,
                chars: contextChars - budget,
                truncated,
              })
            }

            const reply = await generateReply({
              ...replyOptions,
              text: lastPeer.text,
              history: ctx,
            })
            if (!reply) {
              onEvent({ type: 'error', error: '生成的回复是空的' })
            } else {
              onEvent({ type: 'reply', text: reply })

              if (!dryRun) {
                const sent = await sendDM({ browser, text: reply })
                if (sent.ok) {
                  state.lastFingerprint = fp
                  state.count++
                  writeJson(stateFile, state)
                  onEvent({ type: 'sent', text: reply, count: state.count })
                } else {
                  onEvent({ type: 'error', error: '发送失败：' + (sent.error || '未知') })
                }
              } else {
                // dry-run：也更新指纹，避免重复处理同一条
                state.lastFingerprint = fp
                writeJson(stateFile, state)
                onEvent({ type: 'dry-run', text: reply })
              }
            }
          }
        }
      }
    } catch (e) {
      onEvent({ type: 'error', error: String(e?.message || e) })
    }

    if (maxRounds > 0 && rounds >= maxRounds) break
    if (stopped) break

    // 等下一轮（可被 stop 打断）
    const deadline = Date.now() + intervalSec * 1000
    while (Date.now() < deadline && !stopped) {
      await sleep(500)
    }
  }

  return { rounds, state, stop }
}
