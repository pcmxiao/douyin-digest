#!/usr/bin/env node
/**
 * examples/reply-dsh.mjs —— 用标准 LLM messages 生成抖音私信回复
 * ============================================================================
 * 给 `douyin-digest watch --reply-cmd` 用。
 *
 * ┌─ 输入（stdin，JSON）──────────────────────────────────────┐
 * │ {                                                        │
 * │   "messages": [                                          │
 * │     { "role": "user",      "content": "你好" },           │
 * │     { "role": "assistant", "content": "嗨，怎么啦？" },     │
 * │     { "role": "user",      "content": "还可以" }          │
 * │   ],                                                     │
 * │   "persona": "（可选）人设",                               │
 * │   "model":   "（可选）指定模型"                             │
 * │ }                                                        │
 * └──────────────────────────────────────────────────────────┘
 *
 * 输出（stdout）：回复正文，除此之外什么都不输出。
 *
 * ⭐ 上下文是**标准 messages 数组**，直接透传给模型 ——
 *    不拼"对方：xxx"那种文本，也不用反解析。
 *
 * 凭据来源（按顺序）：
 *   ① 环境变量 DEEPSEEK_API_KEY / MINIMAX_API_KEY
 *   ② DSH 的 `~/.dsh/.credentials.yaml` 里已配的 key
 *      （这样不用单独配，直接复用桌面版的凭据）
 *
 * 用法：
 *   douyin-digest watch --reply-cmd "node examples/reply-dsh.mjs" --yes
 *
 * 人设用环境变量传（`--persona` 会被 CLI 参数解析截断）：
 *   $env:REPLY_PERSONA="你是我的抖音小号，说话简短随意"
 * ============================================================================
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 参数 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DEFAULT_PERSONA =
  '你在用抖音私信跟朋友聊天。回复要短，一到两句，口语化，像真人打字。'
  + '不要用 markdown，不要加"回复："之类的前缀，不要客套。'
  + '注意看对话上下文，接住对方的话题，别答非所问。'

// ── 读 stdin ────────────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return ''
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += chunk
  return buf.trim()
}

/**
 * 解析 stdin。
 *
 * 优先按 JSON（标准格式）解析；不是 JSON 就当纯文本消息（兼容老用法）。
 */
function parseInput(raw) {
  if (!raw) return { messages: [], persona: '', model: '' }

  try {
    const j = JSON.parse(raw)
    if (j && Array.isArray(j.messages) && j.messages.length) {
      return {
        messages: j.messages
          .filter((m) => m && m.role && typeof m.content === 'string' && m.content.trim())
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).trim() })),
        persona: typeof j.persona === 'string' ? j.persona : '',
        model: typeof j.model === 'string' ? j.model : '',
      }
    }
  } catch {
    // 不是 JSON
  }

  return {
    messages: [{ role: 'user', content: raw }],
    persona: '',
    model: '',
  }
}

// ── 找凭据 ──────────────────────────────────────────────────────
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CRED = join(DSH_HOME, '.credentials.yaml')

function readCreds() {
  if (!existsSync(CRED)) return {}
  try {
    const raw = readFileSync(CRED, 'utf8')
    const out = {}
    let inRefs = false
    for (const line of raw.split('\n')) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
      if (/^\S/.test(line)) { inRefs = false; continue }   // 踩过坑：JS 正则不支持 \Z
      if (!inRefs) continue
      const m = /^\s+([A-Za-z0-9_]+):\s*(\S+)/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

// ── provider 定义 ───────────────────────────────────────────────
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
    pick: (creds) => process.env.DEEPSEEK_API_KEY || creds.DEEPSEEK_API_KEY || '',
  },
  minimax: {
    label: 'MiniMax',
    // ⚠️ MiniMax 有两个接口域名，这个 key 只认老式的 chatcompletion_v2
    url: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    // 实测可用：MiniMax-M3.1-Flash（最新）、MiniMax-M3、MiniMax-Text-01
    model: 'MiniMax-M3.1-Flash',
    keyEnv: 'MINIMAX_API_KEY',
    pick: (creds) => process.env.MINIMAX_API_KEY || creds.MINIMAX_API_KEY || '',
  },
}

/** 从各家五花八门的返回里抠出正文 */
function extractReply(j) {
  const a = j?.choices?.[0]?.message?.content          // OpenAI 兼容
  if (a) return String(a)
  const b = j?.choices?.[0]?.messages?.[0]?.content    // MiniMax 某些版本
  if (b) return String(b)
  const c = j?.reply                                   // MiniMax 老版
  if (c) return String(c)
  return ''
}

/** 清理模型爱加的东西 */
function clean(text) {
  return String(text || '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/^(回复|回答|说)[:：]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

// ── 主流程 ──────────────────────────────────────────────────────
const raw = await readStdin()
if (!raw) {
  process.stderr.write('reply-dsh: stdin 是空的\n')
  process.exit(1)
}

const { messages, persona, model: wantModel } = parseInput(raw)
if (!messages.length) {
  process.stderr.write('reply-dsh: 解析不出消息\n')
  process.exit(1)
}

// 人设优先级：环境变量 > stdin 里的 persona > 默认
const sys = process.env.REPLY_PERSONA || persona || DEFAULT_PERSONA

const creds = readCreds()
const prefer = arg('--provider', '') || process.env.REPLY_PROVIDER || ''
const order = prefer ? [prefer] : ['deepseek', 'minimax']

let lastErr = ''
for (const name of order) {
  const p = PROVIDERS[name]
  if (!p) continue

  const key = p.pick(creds)
  if (!key) {
    lastErr = `${name}: 没有 key（${p.keyEnv}）`
    continue
  }

  // 模型：环境变量 > stdin 指定 > provider 默认
  const model =
    (name === 'minimax' ? process.env.REPLY_MODEL || '' : '')
    || (name === 'deepseek' ? process.env.REPLY_MODEL || '' : '')
    || wantModel
    || p.model

  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: sys }, ...messages],
        max_tokens: 400,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(90000),
    })

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      lastErr = `${name} HTTP ${res.status}: ${t.slice(0, 200)}`
      continue
    }

    const j = await res.json()

    // MiniMax 的错是 200 + base_resp.status_code
    const code = j?.base_resp?.status_code
    if (code && code !== 0) {
      lastErr = `${name} code=${code}: ${j?.base_resp?.status_msg || ''}`
      continue
    }

    const reply = clean(extractReply(j))
    if (!reply) {
      lastErr = `${name}: 返回是空的（${JSON.stringify(j).slice(0, 200)}）`
      continue
    }

    if (process.env.DEBUG) {
      process.stderr.write(`reply-dsh: ${p.label} / ${model} → ${reply.length} 字\n`)
    }

    process.stdout.write(reply)
    process.exit(0)
  } catch (e) {
    lastErr = `${name}: ${e.message}`
  }
}

process.stderr.write(`reply-dsh: 都失败了\n  ${lastErr}\n`)
process.exit(1)
