#!/usr/bin/env node
/**
 * examples/reply-dsh-headless.mjs —— 用 `dsh headless` 做抖音私信回复
 * ============================================================================
 * 跟 reply-dsh.mjs 的区别：
 *   · reply-dsh.mjs      → 自己读凭据文件，直接调 MiniMax/DeepSeek 的 HTTP API
 *   · reply-dsh-headless → 起一个 `dsh --profile headless` 子进程，用**账号登录**的模型
 *
 * 后者更正统，而且能用上 DSH 的完整 agent 能力（人设、工具、沙箱）。
 *
 * ┌─ 输入（stdin，JSON）──────────────────────────┐
 * │ { "messages": [{role, content}, ...],        │
 * │   "persona": "（可选）",                      │
 * │   "model":   "（可选）" }                     │
 * └──────────────────────────────────────────────┘
 * 输出（stdout）：回复正文（日志全走 stderr）
 *
 * 🔴 关键：`dsh headless` 默认跑不起来，会报
 *      MISSING_CREDENTIAL: no API key for provider route "deepseek-official"
 *    根因（抄 dsh-bili-scroll 的注释，我自己实测确认）：
 *      ① dsh-headless 自带 patch 把 credentials / authorization / deepseek-account
 *         三个服务 disabled 了 ⇒ 读不到凭据库
 *      ② 光打开还不够，agent-default-model 默认解析到 deepseek-official（要 API key）
 *      ③ 桌面版的 workbuddy-ai 在 headless 里没 adapter（NO_ADAPTER）
 *    ⇒ 必须叠一层 overlay：打开三个服务 + 把默认模型指到 deepseek-account
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

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
  for await (const c of process.stdin) buf += c
  return buf.trim()
}

function parseInput(raw) {
  if (!raw) return { messages: [], persona: '' }
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
  } catch { /* 不是 JSON */ }
  // 纯文本兼容
  return { messages: [{ role: 'user', content: raw }], persona: '', model: '' }
}

// ── 找 dsh 可执行文件 ───────────────────────────────────────────
function findDsh() {
  const explicit = process.env.DSH_CLI || arg('--dsh', '')
  if (explicit && existsSync(explicit)) return explicit

  const win = platform() === 'win32'
  const cands = []

  // 桌面版（Electron）常见位置
  if (win) {
    for (const base of ['E:\\DeepSeek Harness', 'C:\\Program Files\\DeepSeek Harness', 'D:\\DeepSeek Harness']) {
      cands.push(join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    }
    // PATH 里直接有
    cands.push('dsh.cmd')
  } else {
    cands.push('/usr/local/bin/dsh', '/opt/homebrew/bin/dsh', join(homedir(), '.local/bin/dsh'))
  }

  for (const c of cands) {
    if (c === 'dsh.cmd' || c === 'dsh') return c   // 交给 shell 解 PATH
    if (existsSync(c)) return c
  }
  return ''
}

// ── 写 overlay ──────────────────────────────────────────────────
/**
 * overlay 是最后叠的一层（bundle → profile → --patch），所以能把
 * headless 自带的禁用/默认值覆盖掉。
 */
function ensureOverlay(model) {
  const dir = join(homedir(), '.douyin-digest')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'headless-overlay.yml')

  const lines = [
    '# 自动生成，别手改（改 examples/reply-dsh-headless.mjs 里的模板）',
    '#',
    '# ① 打开被 dsh-headless 禁用的三个服务（否则读不到凭据库）',
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
    '#',
    '# ② 默认模型指到账号登录（deepseek-official 要 API key，workbuddy-ai 无 adapter）',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
    `    model: ${model || 'deepseek-chat'}`,
  ]

  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

// ── 把 messages 拼成 prompt ─────────────────────────────────────
function buildPrompt(messages, persona) {
  const lines = []

  if (persona) {
    lines.push('（说话风格按这份人设来：')
    lines.push(persona)
    lines.push('）')
    lines.push('')
  }

  // 除了最后一条，其余都是历史
  const history = messages.slice(0, -1)
  const last = messages[messages.length - 1]

  if (history.length) {
    lines.push('对话记录：')
    for (const m of history) {
      lines.push((m.role === 'assistant' ? '我' : '对方') + '：' + m.content)
    }
    lines.push('')
  }

  lines.push(`对方刚发来：${JSON.stringify(last.content)}`)
  lines.push('')
  lines.push('直接输出你要回的那句话，只输出正文。')
  lines.push('⚠️ 不要输出解释、不要加“回复：”前缀、不要用 markdown。')

  return lines.join('\n')
}

// ── 跑 ─────────────────────────────────────────────────────────
const raw = await readStdin()
if (!raw) {
  process.stderr.write('reply-dsh-headless: stdin 是空的\n')
  process.exit(1)
}

const { messages, persona, model } = parseInput(raw)
if (!messages.length) {
  process.stderr.write('reply-dsh-headless: 解析不出消息\n')
  process.exit(1)
}

const sys = process.env.REPLY_PERSONA || persona || DEFAULT_PERSONA
const wantModel = process.env.REPLY_MODEL || model || 'deepseek-chat'
const profile = process.env.REPLY_PROFILE || 'headless'

const dsh = findDsh()
if (!dsh) {
  process.stderr.write(
    'reply-dsh-headless: 找不到 dsh。\n'
    + '  用 DSH_CLI 环境变量指定，或者 --dsh <路径>\n',
  )
  process.exit(1)
}

const overlay = ensureOverlay(wantModel)
const prompt = buildPrompt(messages, sys)

const isWin = platform() === 'win32'
const args = ['--profile', profile, '--patch', overlay]

// dsh.cmd 要用 cmd /c 调，否则 Windows 上 spawn 不到
const child = spawn(
  isWin && /\.cmd$/i.test(dsh) ? 'cmd' : dsh,
  isWin && /\.cmd$/i.test(dsh) ? ['/c', dsh, ...args] : args,
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  },
)

let stdout = ''
let stderr = ''
child.stdout.on('data', (b) => { stdout += String(b) })
child.stderr.on('data', (b) => { stderr += String(b) })

const timer = setTimeout(() => {
  try { child.kill() } catch { /* 忽略 */ }
}, 180000)

child.on('error', (e) => {
  clearTimeout(timer)
  process.stderr.write(`reply-dsh-headless: 起不来：${e.message}\n`)
  process.exit(1)
})

child.on('exit', (code) => {
  clearTimeout(timer)

  if (code !== 0) {
    process.stderr.write(`reply-dsh-headless: dsh 退出 ${code}\n`)
    process.stderr.write(stderr.slice(-600) + '\n')
    process.exit(1)
  }

  // stderr 里混着 dsh 的日志，用它排错
  if (process.env.DEBUG) process.stderr.write(stderr.slice(-400) + '\n')

  // stdout 才是回复；去掉可能的日志行
  const reply = stdout
    .split('\n')
    .filter((l) => !/^\[llm-|^\[dsh|^\[agent/.test(l.trim()))
    .join('\n')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/^(回复|回答)[:：]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, ' ')
    .trim()

  if (!reply) {
    process.stderr.write('reply-dsh-headless: 回复是空的\n')
    process.stderr.write(stderr.slice(-400) + '\n')
    process.exit(1)
  }

  process.stdout.write(reply)
  process.exit(0)
})

child.stdin.write(prompt)
child.stdin.end()
