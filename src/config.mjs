/**
 * src/config.mjs —— 配置与家目录
 * ============================================================================
 * 数据放 `~/.douyin-digest/`：
 *   profiles/douyin/   浏览器 profile（登录态在这里）
 *   out/<日期>.md      日报
 *   seen.md            判重表
 *   config.json        配置
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const HOME = process.env.DOUYIN_DIGEST_HOME || join(homedir(), '.douyin-digest')

export function ensureHome() {
  for (const d of [HOME, join(HOME, 'out'), join(HOME, 'profiles')]) {
    mkdirSync(d, { recursive: true })
  }
  return HOME
}

export const paths = {
  home: HOME,
  profile: () => join(HOME, 'profiles', 'douyin'),
  out: () => join(HOME, 'out'),
  seen: () => join(HOME, 'seen.md'),
  config: () => join(HOME, 'config.json'),
  report: (day) => join(HOME, 'out', `${day}.md`),
}

export const DEFAULTS = {
  port: 47880,
  browserPath: '',
  keywords: ['DeepSeek'],
  /** 一次搜多少条 */
  searchLimit: 20,
  /** 读几条详情（最贵的一步） */
  readLimit: 3,
  /** 挑几条进日报 */
  topN: 3,
  /** 日报写多细：full / brief / off */
  reportLevel: 'full',
  /** 分享给谁：留空 = 第一个互关好友 */
  shareTo: '',
}

export function loadConfig() {
  ensureHome()
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(paths.config(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(patch) {
  ensureHome()
  const next = { ...loadConfig(), ...patch }
  writeFileSync(paths.config(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 判重表（人也能读的 markdown）。
 * ⚠️ 用 markdown 而不是 json：使用者能直接打开看、能手动删行，
 *    也不会因为写一半就整个文件报废。
 */
export class Seen {
  constructor() {
    ensureHome()
    this.file = paths.seen()
    this.set = new Set()
    this.#load()
  }

  #load() {
    if (!existsSync(this.file)) return
    try {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        const m = /^\|\s*\S+\s*\|\s*(\d+)\s*\|/.exec(line)
        if (m) this.set.add(m[1])
      }
    } catch { /* 读不出来就当空的 */ }
  }

  has(id) { return this.set.has(String(id)) }

  add(id, title = '') {
    const k = String(id)
    if (this.set.has(k)) return
    this.set.add(k)
    try {
      if (!existsSync(this.file)) {
        writeFileSync(this.file,
          '# 看过的抖音视频（可以手动删行）\n\n| 日期 | id | 标题 |\n|---|---|---|\n', 'utf8')
      }
      const safe = String(title || '').replace(/\|/g, '／').replace(/\n/g, ' ').slice(0, 60)
      appendFileSync(this.file, `| ${dayKey()} | ${k} | ${safe} |\n`, 'utf8')
    } catch { /* 写不进去也不能炸 */ }
  }

  get size() { return this.set.size }
}
