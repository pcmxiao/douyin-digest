/**
 * src/index.mjs —— 库入口（给想在代码里用的人）
 */
export { search, detail, share, readDM, sendDM, checkLogin, parseCount, parseDuration, parseTime } from './douyin.mjs'
export { score, composeContent } from './score.mjs'
export { runRound, renderReport } from './digest.mjs'
export { getBrowser, findBrowser, Browser } from './browser.mjs'
export { loadConfig, saveConfig, ensureHome, paths, Seen, dayKey } from './config.mjs'
