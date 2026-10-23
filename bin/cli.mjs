#!/usr/bin/env node
/**
 * bin/cli.mjs —— douyin-digest 命令行入口
 * ============================================================================
 * 零依赖，只要 Node 22+ 和一个浏览器（Edge / Chrome）。
 *
 * 命令：
 *   login                     打开浏览器扫码登录（登录态持久化）
 *   status                    看登录态、家目录、判重表
 *   search <关键词>            只搜索，列结果
 *   read <视频id>              读一个视频的文案 + 评论
 *   digest                    完整一轮（搜→读→打分→日报）
 *   share <视频id>            分享一个视频给互关好友
 *   dm                        读私信
 *   say <文本>                 发私信
 *   config [key] [value]      读写配置
 * ============================================================================
 */
import { getBrowser, findBrowser } from '../src/browser.mjs'
import { search, detail, share, readDM, sendDM, checkLogin } from '../src/douyin.mjs'
import { runRound, renderReport } from '../src/digest.mjs'
import { score, composeContent } from '../src/score.mjs'
import { loadConfig, saveConfig, ensureHome, paths, Seen, dayKey } from '../src/config.mjs'
import { existsSync, readFileSync } from 'node:fs'

// ── 输出工具 ────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
}
const noColor = process.env.NO_COLOR || !process.stdout.isTTY
const c = (code, s) => (noColor ? String(s) : `${code}${s}${C.reset}`)
const bold = (s) => c(C.bold, s)
const dim = (s) => c(C.gray, s)
const ok = (s) => c(C.green, '✓ ' + s)
const bad = (s) => c(C.red, '✗ ' + s)
const warn = (s) => c(C.yellow, '! ' + s)
const info = (s) => c(C.cyan, s)

const out = (s = '') => process.stdout.write(s + '\n')

// ── 参数解析 ────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args.flags[key] = next; i++ }
      else args.flags[key] = true
    } else {
      args._.push(a)
    }
  }
  return args
}

function fmtDur(sec) {
  const s = Number(sec) || 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtNum(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
  return String(v)
}

// ── 浏览器 ──────────────────────────────────────────────────────
async function withBrowser(fn, { headless = false } = {}) {
  ensureHome()
  const cfg = loadConfig()

  const exe = cfg.browserPath || findBrowser()
  if (!exe) {
    out(bad('找不到 Edge / Chrome'))
    out('  装一个浏览器，或者指定路径：')
    out(`    douyin-digest config browserPath "C:\\path\\to\\chrome.exe"`)
    process.exit(1)
  }

  const browser = await getBrowser({
    exe,
    userDataDir: paths.profile(),
    port: cfg.port,
    log: (m) => { if (process.env.DEBUG) out(dim('[browser] ' + m)) },
  })

  try {
    return await fn(browser, cfg)
  } finally {
    // ⚠️ 不关浏览器 —— 登录态要留着，下次能直接连
    //    （只断开 CDP，进程留着）
    try { browser.ws?.close() } catch { /* 忽略 */ }
  }
}

// ── 命令实现 ────────────────────────────────────────────────────

async function cmdLogin(args) {
  const cfg = loadConfig()
  out(bold('登录抖音'))
  out(dim(`  家目录：${paths.home}`))
  out(dim(`  profile：${paths.profile()}`))
  out('')

  await withBrowser(async (b) => {
    const st = await checkLogin(b)
    if (st.loggedIn) {
      out(ok(`已经登录了（${st.detail}）`))
      return
    }

    out('打开抖音首页…')
    await b.goto('https://www.douyin.com/', { settleMs: 8000 })
    out('')
    out(warn('请在弹出的浏览器窗口里扫码登录抖音小号'))
    out(dim('  · 登录后不用关窗口，登录态会保存在 profile 里'))
    out(dim('  · 之后所有命令都会复用这个登录态'))
    out('')

    // 轮询等登录
    const deadline = Date.now() + 5 * 60 * 1000
    let last = ''
    while (Date.now() < deadline) {
      const s = await checkLogin(b)
      const sec = Math.ceil((deadline - Date.now()) / 1000)
      const line = `等待登录… 还剩 ${sec}s`
      if (line !== last) {
        process.stdout.write('\r  ' + dim(line) + '   ')
        last = line
      }
      if (s.loggedIn) {
        process.stdout.write('\r' + ' '.repeat(40) + '\r')
        out('')
        out(ok('登录成功'))
        // 存一份 cookie 供参考（不含敏感输出）
        const ck = await b.cookies(['https://www.douyin.com/'])
        saveConfig({ lastLoginAt: new Date().toISOString(), cookieCount: ck.length })
        return
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    process.stdout.write('\r' + ' '.repeat(40) + '\r')
    out('')
    out(bad('5 分钟内没检测到登录'))
    out(dim('  窗口不会关。扫码后重新跑 douyin-digest login 即可'))
  })
}

async function cmdStatus(args) {
  const cfg = loadConfig()
  const seen = new Seen()

  out(bold('douyin-digest 状态'))
  out('')
  out(`  家目录    ${paths.home}`)
  out(`  profile   ${paths.profile()}`)
  out(`  日报目录  ${paths.out()}`)
  out(`  判重表    ${paths.seen()} ${dim(`(${seen.size} 条)`)}`)
  out('')

  const browser = findBrowser()
  out(`  浏览器    ${browser || bad('没找到')}`)
  out('')

  if (!browser) return

  await withBrowser(async (b) => {
    const st = await checkLogin(b)
    out(st.loggedIn ? ok(st.detail) : bad(st.detail))
    if (!st.loggedIn) {
      out(dim('  跑 douyin-digest login 扫码登录'))
    }
  })
}

async function cmdSearch(args) {
  const kw = args._[1]
  if (!kw) { out(bad('用法：douyin-digest search <关键词>')); process.exit(1) }
  const cfg = loadConfig()
  const limit = Number(args.flags.limit) || cfg.searchLimit

  await withBrowser(async (b) => {
    out(dim(`搜索「${kw}」…`))
    const list = await search({ browser: b, keyword: kw, limit })

    if (!list.length) { out(warn('没有结果')); return }

    out('')
    out(bold(`找到 ${list.length} 条`))
    out('')

    const seen = new Seen()
    const ranked = list
      .map((x) => ({ x, ...score(x, null, { keywords: [kw] }) }))
      .sort((a, b2) => b2.score - a.score)

    for (const r of ranked) {
      const mark = seen.has(r.x.id) ? dim('看过') : ''
      out(`  ${c(C.cyan, String(r.score).padStart(4))}  ${dim(fmtDur(r.x.durationSec).padStart(6))}  ${dim(fmtNum(r.x.play).padStart(7))}  ${r.x.title.slice(0, 44)}`)
      out(`        ${dim('@' + (r.x.author || '?'))}  ${dim(r.x.id)}  ${mark}`)
    }
  })
}

async function cmdRead(args) {
  const id = args._[1]
  if (!id) { out(bad('用法：douyin-digest read <视频id>')); process.exit(1) }

  await withBrowser(async (b) => {
    out(dim(`读取 ${id}…`))
    const d = await detail({ browser: b, id, commentLimit: 20 })
    if (!d.ok) { out(bad(d.error)); return }

    const content = composeContent(d)
    out('')
    out(bold(d.desc || dim('(没有文案)')))
    out('')
    if (d.tags.length) out(dim('话题：' + d.tags.map((t) => '#' + t).join(' ')))
    out(dim(`数据：赞 ${fmtNum(d.stats.digg)} · 评 ${fmtNum(d.stats.comment)} · 藏 ${fmtNum(d.stats.collect)} · 分 ${fmtNum(d.stats.share)}`))
    out('')
    if (d.comments.length) {
      out(bold(`评论 ${d.comments.length} 条`))
      for (const cm of d.comments) {
        out(`  ${c(C.cyan, cm.user)}${cm.like ? dim(`（${cm.like} 赞）`) : ''}`)
        out(`    ${cm.text}`)
      }
    } else {
      out(dim('（没拿到评论）'))
    }
  })
}

async function cmdDigest(args) {
  const cfg = loadConfig()
  const dryRun = !args.flags.yes && !args.flags.share   // 只有明确要分享才真做
  const keywords = args.flags.kw
    ? String(args.flags.kw).split(',').map((s) => s.trim()).filter(Boolean)
    : cfg.keywords
  const readLimit = Number(args.flags.read ?? cfg.readLimit)
  const topN = Number(args.flags.top ?? cfg.topN)
  const doReport = args.flags.report !== false && cfg.reportLevel !== 'off'
  const doShare = Boolean(args.flags.share)

  out(bold('抖音精选 · 一轮'))
  out(dim(`  关键词：${keywords.join(', ')}`))
  out(dim(`  读 ${readLimit} 条详情，挑 ${topN} 条`))
  out(dim(`  模式：${dryRun ? 'dry-run（不写文件、不分享）' : '实际执行'}`))
  out('')

  await withBrowser(async (b) => {
    const r = await runRound({
      browser: b,
      keywords,
      searchLimit: cfg.searchLimit,
      readLimit,
      topN,
      doReport,
      doShare,
      dryRun,
      shareTo: cfg.shareTo,
      onLog: (m) => out(m),
    })

    out('')
    out(bold('结果'))
    out(`  候选 ${r.candidates} → 判重 ${r.fresh} → 读 ${r.read} → 挑 ${r.picked.length}`)
    if (r.reportPath) out(`  日报：${r.reportPath}`)
    if (r.shared.length) out(`  分享：${r.shared.length} 条成功`)
    if (r.errors.length) {
      out('')
      out(warn(`${r.errors.length} 个错误：`))
      for (const e of r.errors.slice(0, 5)) out('  ' + e)
    }

    if (dryRun && r.picked.length) {
      out('')
      out(dim('想真跑？加 --yes 写日报，加 --share 分享'))
    }
  })
}

async function cmdShare(args) {
  const id = args._[1]
  if (!id) { out(bad('用法：douyin-digest share <视频id> [--to 好友名]')); process.exit(1) }
  const dryRun = !args.flags.yes

  await withBrowser(async (b) => {
    out(dim(`分享 ${id}${dryRun ? '（dry-run）' : ''}…`))
    const r = await share({ browser: b, id, to: args.flags.to || '', dryRun })
    if (r.ok) {
      out(ok(r.dryRun ? `本来要分享给「${r.friend}」` : `已分享给「${r.friend}」`))
    } else {
      out(bad(r.error || '分享失败'))
    }
  })
}

async function cmdDM(args) {
  await withBrowser(async (b) => {
    out(dim('打开私信…'))
    const r = await readDM({ browser: b, limit: 30 })
    if (!r.ok) {
      out(bad(r.error || '读取失败'))
      if (r.debug && process.env.DEBUG) out(dim('  调试：' + JSON.stringify(r.debug)))
      return
    }
    out('')
    out(bold(`最近消息（共 ${r.total} 条，显示最近 ${r.messages.length} 条）`))
    out('')
    for (const m of r.messages) {
      if (m.fromMe) {
        out(`  ${c(C.blue, '我 →')} ${m.isShare ? dim('[分享卡片] ') : ''}${m.text}`)
      } else {
        out(`  ${c(C.green, '← 对方')} ${m.isShare ? dim('[分享卡片] ') : ''}${m.text}`)
      }
    }
  })
}

async function cmdSay(args) {
  const text = args._.slice(1).join(' ')
  if (!text) { out(bad('用法：douyin-digest say <文本>')); process.exit(1) }

  await withBrowser(async (b) => {
    out(dim('发送私信…'))
    const r = await sendDM({ browser: b, text })
    out(r.ok ? ok('已发送') : bad(r.error || '发送失败'))
  })
}

async function cmdWatch(args) {
  const { runWatch } = await import('../src/watch.mjs')

  const intervalSec = Number(args.flags.interval) || 30
  const maxPerDay = Number(args.flags['max-per-day']) || 50
  const maxRounds = Number(args.flags.rounds) || 0
  const contextChars = Number(args.flags.ctx) || 600000
  const dryRun = !args.flags.yes
  const persona = String(args.flags.persona || process.env.REPLY_PERSONA || '')
  const apiKey = String(args.flags['api-key'] || process.env.DEEPSEEK_API_KEY || '')
  const apiBase = String(args.flags['api-base'] || 'https://api.deepseek.com')
  const model = String(args.flags.model || process.env.REPLY_MODEL || 'deepseek-chat')
  const replyCmd = String(args.flags['reply-cmd'] || '')

  // 决定回复方式
  let mode = 'echo'
  if (replyCmd) mode = 'cmd'
  else if (apiKey) mode = 'api'

  out(bold('私信自动回复'))
  out('')
  out(`  轮询间隔   ${intervalSec} 秒`)
  out(`  每天上限   ${maxPerDay} 条`)
  out(`  上下文     ${Math.round(contextChars / 1000)}k 字符（粗估 ${Math.round(contextChars * 1.3 / 1000)}k token）`)
  out(`  回复方式   ${
    mode === 'api' ? `API（${model}）`
      : mode === 'cmd' ? `外部命令：${replyCmd.slice(0, 40)}`
        : '回显（测试用，把收到的原样回一句）'
  }`)
  out(`  模式       ${dryRun ? c(C.yellow, 'dry-run（不真发）') : '真发'}`)
  out('')
  if (mode === 'echo') {
    out(dim('  💡 想接真模型：加 --api-key sk-xxx，或者 --reply-cmd "你的脚本"'))
    out('')
  }
  out(dim('  Ctrl+C 停止'))
  out('')

  if (mode === 'api' && !apiKey) {
    out(bad('--api-key 是空的'))
    process.exit(1)
  }

  await withBrowser(async (b) => {
    // 处理 Ctrl+C
    let watch = null
    const onSig = () => {
      out('')
      out(dim('收摊…'))
      try { watch?.stop?.() } catch { /* 忽略 */ }
      process.exit(0)
    }
    process.on('SIGINT', onSig)

    watch = await runWatch({
      browser: b,
      intervalSec,
      maxPerDay,
      contextChars,
      dryRun,
      maxRounds,
      replyOptions: {
        mode,
        persona,
        apiKey,
        apiBase,
        model,
        replyCmd,
        log: () => {},
      },
      onEvent: (e) => {
        const ts = new Date().toLocaleTimeString('zh-CN')
        switch (e.type) {
          case 'idle':
            out(dim(`[${ts}] 等待中 · ${e.reason}`))
            break
          case 'context':
            out(dim(`[${ts}] 上下文：${e.used}/${e.total} 条，${e.chars} 字符${e.truncated ? '（已截断）' : ''}`))
            break
          case 'received':
            out('')
            out(c(C.green, `[${ts}] ← 对方：`) + e.text)
            break
          case 'reply':
            out(c(C.blue, `[${ts}] → 我要回：`) + e.text)
            break
          case 'sent':
            out(dim(`[${ts}] ✓ 已发送（今天第 ${e.count} 条）`))
            break
          case 'dry-run':
            out(dim(`[${ts}] dry-run：没真发`))
            break
          case 'limit':
            out(c(C.yellow, `[${ts}] ! ${e.reason}`))
            break
          case 'error':
            out(c(C.red, `[${ts}] ✗ ${e.error}`))
            break
          default:
            break
        }
      },
    })

    out('')
    out(dim(`跑了 ${watch.rounds} 轮，今天回了 ${watch.state.count} 条`))
  })
}

async function cmdConfig(args) {
  const key = args._[1]
  const val = args._[2]

  if (!key) {
    out(bold('当前配置'))
    out('')
    const cfg = loadConfig()
    for (const [k, v] of Object.entries(cfg)) {
      out(`  ${k.padEnd(16)} ${JSON.stringify(v)}`)
    }
    out('')
    out(dim(`配置文件：${paths.config()}`))
    return
  }

  if (val === undefined) {
    const cfg = loadConfig()
    out(JSON.stringify(cfg[key], null, 2))
    return
  }

  let parsed = val
  if (val === 'true') parsed = true
  else if (val === 'false') parsed = false
  else if (/^\d+$/.test(val)) parsed = Number(val)
  else if (val.startsWith('[')) {
    try { parsed = JSON.parse(val) } catch { parsed = val.split(',').map((s) => s.trim()) }
  }

  saveConfig({ [key]: parsed })
  out(ok(`${key} = ${JSON.stringify(parsed)}`))
}

async function cmdToday(args) {
  const f = paths.report(dayKey())
  if (!existsSync(f)) { out(dim('今天的日报还没生成')); return }
  out(readFileSync(f, 'utf8'))
}

function cmdHelp() {
  out(bold('douyin-digest') + dim(' —— 抖音精选：搜索、读内容、挑出值得看的'))
  out('')
  out(bold('用法'))
  out('  douyin-digest <命令> [参数]')
  out('')
  out(bold('命令'))
  const cmds = [
    ['login', '扫码登录（登录态持久化，只需一次）'],
    ['status', '看登录态和环境'],
    ['search <关键词>', '搜索并打分排序'],
    ['read <视频id>', '读一个视频的文案 + 评论'],
    ['digest', '完整一轮（搜 → 读 → 打分 → 日报）'],
    ['share <视频id>', '分享视频给互关好友'],
    ['dm', '读私信（区分谁发的）'],
    ['say <文本>', '发私信'],
    ['watch', '私信自动回复（AI 聊天）'],
    ['today', '看今天的日报'],
    ['config [k] [v]', '读写配置'],
  ]
  for (const [cmd, desc] of cmds) {
    out(`  ${c(C.cyan, cmd.padEnd(20))} ${dim(desc)}`)
  }
  out('')
  out(bold('常用参数'))
  out(`  ${c(C.cyan, '--kw a,b')}          ${dim('关键词（逗号分隔）')}`)
  out(`  ${c(C.cyan, '--read N')}          ${dim('读几条详情（默认 3）')}`)
  out(`  ${c(C.cyan, '--top N')}           ${dim('挑几条（默认 3）')}`)
  out(`  ${c(C.cyan, '--share')}           ${dim('digest 时顺便分享')}`)
  out(`  ${c(C.cyan, '--yes')}             ${dim('写入日报 / 真分享（否则 dry-run）')}`)
  out(`  ${c(C.cyan, '--to <好友名>')}      ${dim('分享给指定好友')}`)
  out('')
  out(bold('watch 专用参数'))
  out(`  ${c(C.cyan, '--interval N')}      ${dim('轮询间隔秒数（默认 30）')}`)
  out(`  ${c(C.cyan, '--ctx N')}           ${dim('上下文预算，字符数（默认 600000 ≈ 780k token）')}`)
  out(`  ${c(C.cyan, '--api-key sk-xxx')}  ${dim('用 API 生成回复（也可用 DEEPSEEK_API_KEY 环境变量）')}`)
  out(`  ${c(C.cyan, '--model M')}         ${dim('指定模型')}`)
  out(`  ${c(C.cyan, '--persona "…"')}     ${dim('人设提示词（建议用 REPLY_PERSONA 环境变量）')}`)
  out(`  ${c(C.cyan, '--reply-cmd "…"')}   ${dim('用外部命令生成回复（stdin 收 JSON messages，stdout 出回复）')}`)
  out(`  ${c(C.cyan, '--max-per-day N')}   ${dim('每天最多回几条（默认 50）')}`)
  out(`  ${c(C.cyan, '--rounds N')}        ${dim('跑几轮就停（默认不限）')}`)
  out(`  ${c(C.cyan, '--yes')}             ${dim('真发（不加就是 dry-run，只看会回什么）')}`)
  out('')
  out(bold('例子'))
  out(dim('  douyin-digest login'))
  out(dim('  douyin-digest search "DeepSeek"'))
  out(dim('  douyin-digest digest --kw "DeepSeek,AI" --read 3 --top 2 --share --yes'))
  out(dim('  douyin-digest watch --rounds 1                    # 先看会回什么（dry-run）'))
  out(dim('  douyin-digest watch --api-key sk-xxx --yes        # 真跑'))
  out('')
  out(bold('说明'))
  out(dim('  · 零依赖，只需 Node 22+ 和 Edge / Chrome'))
  out(dim('  · 数据都在 ~/.douyin-digest/，不写进当前目录'))
  out(dim('  · digest / share / watch 默认 dry-run，要看真效果加 --yes'))
  out(dim('  · watch 只回「对方发的」消息，每条只回一次，每天有上限'))
}

// ── 主入口 ──────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  ensureHome()

  switch (cmd) {
    case 'login': return cmdLogin(args)
    case 'status': return cmdStatus(args)
    case 'search': return cmdSearch(args)
    case 'read': return cmdRead(args)
    case 'digest': return cmdDigest(args)
    case 'share': return cmdShare(args)
    case 'dm': return cmdDM(args)
    case 'say': return cmdSay(args)
    case 'watch': return cmdWatch(args)
    case 'today': return cmdToday(args)
    case 'config': return cmdConfig(args)
    case 'help': case '-h': case '--help': case undefined: return cmdHelp()
    default:
      out(bad(`不认识的命令：${cmd}`))
      out('')
      return cmdHelp()
  }
}

main().catch((e) => {
  out('')
  out(bad(e?.message || String(e)))
  if (process.env.DEBUG) out(dim(e.stack || ''))
  process.exit(1)
})
