// quota-retry: 拦截配额类 429, 注入精确 retry-after-ms, 让 opencode 原生重试在
// 限额重置后再进行, 而不是 5 次指数退避(~70s)后放弃。
//
// 背景:
//   opencode v1.18.12+(commit c789868) 把 session stream 重试上限钉死为 5 次
//   (packages/opencode/src/session/retry.ts: RETRY_MAX_RETRIES = 5)。
//   对"5 小时/月配额"类 provider(智谱 coding plan、火山 coding plan), 配额耗尽后
//   5 次重试只覆盖 ~70s, 会话直接中断 —— 而错误信息本身说明配额几小时/几天后才重置。
//
// 机制:
//   retry.ts 的 delay() 优先读响应 header:
//     1. retry-after-ms (毫秒)
//     2. retry-after (秒或 HTTP-date)
//     3. 都没有才走指数退避
//   实测(v1.18.18): 自定义 header 会完整流到 error.data.responseHeaders。
//   本插件通过 config hook 给目标 provider 注入自定义 fetch (provider.options.fetch),
//   拦截 429 响应并按配额 API / body 时间戳计算精确等待, 注入 retry-after-ms。
//   第一次重试即落在限额重置之后 → 5 次上限碰不到; TUI 显示原生重试状态条。
//
// 更新机制(借鉴 opencode-acp 的"删除+重装"思路):
//   opencode 对 git 插件只安装一次(缓存 ~/.cache/opencode/packages/), 之后不再拉取。
//   本插件每次启动时用 git ls-remote 比对 GitHub master 的 HEAD(10s 超时):
//   - 有新提交: 删除自己的 wrapper 目录(含 package-lock, 钉死旧 commit 的元凶)。
//     opencode 重启时检测到缺失会自动重新安装最新版。
//   - 无新提交 / 网络不可达: 不动。
//   同步发生在当前进程加载之后, 新代码在下一次 opencode 启动时生效
//   (即: 发布新版本后重启两次)。syncEnabled: false 可关闭。
//
// 闭包边界(不改什么):
//   - 不碰重试次数上限(插件够不到 Effect 调度层), 上游 issue:
//     https://github.com/anomalyco/opencode/issues/43596
//   - 非配额 429(并发限流等): 不注入, 原样交还 opencode 原生指数退避
//   - 标题生成走 SDK 层 retries:2, 不读 retry-after-ms, 失败无害
//   - 非 429 响应原样透传
//   - 配额 API 只在"确认配额耗尽"的 429 时才调用, 且有 cache 兜底

import { execFile, execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "yangyaofei/opencode-quota-retry"
const BRANCH = "master"

type ProviderConfig = {
  id: string
  quota: "zhipu" | "body"
  quotaUrl?: string
  quotaMatch?: string
  resetExtract?: string
  fallbackWaitMs?: number
  bufferMs?: number
  apiKey?: string
}

type PatchConfig = {
  enabled?: boolean
  maxRetries?: number
  backoffCapMs?: number
  restore?: boolean
}

type PluginConfig = {
  providers: ProviderConfig[]
  quotaCacheMs?: number
  syncEnabled?: boolean
  repo?: string
  patch?: PatchConfig
}

const DEFAULT_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
const DEFAULT_FALLBACK_WAIT_MS = 30_000
const DEFAULT_QUOTA_CACHE_MS = 60_000
const DEFAULT_BUFFER_MS = 10_000
// 判定 429 是不是配额耗尽的默认正则(智谱+火山特征)
const DEFAULT_QUOTA_MATCH = 'AccountQuotaExceeded|usage quota|使用上限|限额将在|"code"\\s*:\\s*"1308"'
// 从 body 提取重置时间的默认正则(捕获组 1 = 完整时间串)
const DEFAULT_RESET_EXTRACT = "((?:\\d{4}-\\d{2}-\\d{2})[\\sT]\\d{2}:\\d{2}:\\d{2})"

function configDir(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config")
}

function globalConfigPath(): string {
  return path.join(configDir(), "opencode", "quota-retry.jsonc")
}

function dataDir(): string {
  return process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share")
}

function authFilePath(): string {
  return path.join(dataDir(), "opencode", "auth.json")
}

// JSONC: 去掉字符串外的 // 与 /* */ 注释后按 JSON 解析
function stripJsoncComments(text: string): string {
  let out = ""
  let i = 0
  let inString = false
  let inLine = false
  let inBlock = false
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      i++
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        out += "  "
        i += 2
        continue
      }
      out += c === "\n" ? "\n" : " "
      i++
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      inLine = true
      i += 2
      continue
    }
    if (c === "/" && next === "*") {
      inBlock = true
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function loadConfig(projectDir: string): PluginConfig {
  const candidates = [
    path.join(projectDir, ".opencode", "quota-retry.jsonc"),
    globalConfigPath(),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      return JSON.parse(stripJsoncComments(readFileSync(file, "utf8"))) as PluginConfig
    } catch (err) {
      console.error(`[quota-retry] config parse failed: ${file}`, err)
    }
  }
  return { providers: [] }
}

function readApiKey(providerID: string): string | undefined {
  try {
    if (!existsSync(authFilePath())) return undefined
    const data = JSON.parse(readFileSync(authFilePath(), "utf8"))
    const entry = data[providerID]
    if (entry && entry.type === "api" && typeof entry.key === "string") return entry.key
  } catch {}
  return undefined
}

// 从本次请求的 headers 里提取 Bearer token(实际使用的 key, 不依赖 auth.json)
function matchBearer(v: string | null | undefined): string | undefined {
  if (!v) return undefined
  const m = v.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : undefined
}

function extractBearerFromInit(init?: Parameters<typeof fetch>[1]): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") {
    return matchBearer((headers as Headers).get("authorization"))
  }
  if (Array.isArray(headers)) {
    const pair = headers.find(([k]) => String(k).toLowerCase() === "authorization")
    return pair ? matchBearer(String(pair[1])) : undefined
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (String(k).toLowerCase() === "authorization") return matchBearer(String(v))
  }
  return undefined
}

// 自同步: 比对 GitHub HEAD, 有新提交则删除本地 wrapper, 重启后 opencode 重装最新版
function pluginDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
}

// wrapper 目录 = 插件目录的上级上级(形如 ~/.cache/opencode/packages/<spec>/),
// 判定依据: 其 package.json 依赖里声明了插件名
function wrapperDir(dir: string): string | undefined {
  const name = path.basename(dir)
  const parent = path.dirname(path.dirname(dir))
  try {
    const pkg = JSON.parse(readFileSync(path.join(parent, "package.json"), "utf8"))
    return pkg?.dependencies?.[name] ? parent : undefined
  } catch {
    return undefined
  }
}

// 当前已安装版本: package-lock.json 的 resolved 字段里的 commit sha
// (形如 git+ssh://...#dd4948213f60ab379ab523613852bc5f776e365b)
function currentCommit(wrapper: string): string | undefined {
  try {
    const lock = JSON.parse(readFileSync(path.join(wrapper, "package-lock.json"), "utf8"))
    for (const entry of Object.values(lock.packages ?? {})) {
      const resolved = (entry as { resolved?: unknown })?.resolved
      if (typeof resolved === "string") {
        const m = resolved.match(/#([0-9a-f]{40})$/)
        if (m) return m[1]
      }
    }
  } catch {}
  return undefined
}

// 安装 spec 里的 ref(分支名): wrapper 的依赖声明形如
//   "opencode-quota-retry": "github:owner/repo#patch-max-retries"
// 无 # 时默认 master。同步按此 ref 比对, 分支安装时同步也对分支生效
function specRef(wrapper: string, name: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(wrapper, "package.json"), "utf8"))
    const dep = pkg?.dependencies?.[name]
    if (typeof dep === "string") {
      const m = dep.match(/#([^#]+)$/)
      if (m && !/^[0-9a-f]{40}$/.test(m[1])) return m[1]
    }
  } catch {}
  return BRANCH
}

function latestCommit(repo: string, ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", `https://github.com/${repo}.git`, `refs/heads/${ref}`],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(undefined)
        resolve(stdout.split(/\s+/)[0] || undefined)
      },
    )
  })
}

async function syncPlugin(repo: string, notify: (title: string, message: string) => void): Promise<void> {
  const dir = pluginDir()
  if (!dir) return
  const wrapper = wrapperDir(dir)
  if (!wrapper) return
  const cur = currentCommit(wrapper)
  const latest = await latestCommit(repo, specRef(wrapper, path.basename(dir)))
  if (!cur || !latest || cur === latest) return
  try {
    rmSync(wrapper, { recursive: true, force: true })
    notify("quota-retry 已同步", "检测到新版本, 旧副本已删除, 重启 opencode 生效")
  } catch {
    // 删除失败: 静默, 下次启动再试
  }
}

// ===== 二进制补丁: 修改 opencode 硬编码的 RETRY_MAX_RETRIES(5) =====
// 原理: opencode 是 bun 单二进制, 内嵌 JS 明文。压缩后的常量链形如
//   ...,TH=30000,DH=2147483647,RV=5,...  (RV 为重试上限变量)
//   ...attempt>RV)...                     (上限判定点)
// 锚定 2147483647(max delay)定位链, 等长替换:
//   maxRetries=-1  → 比较式 attempt>RV) 改为恒假的 attempt<-1 ), 无限重试
//   maxRetries=N   → 改链中 RV 的数值, 位数增减从 TH(30000, 无 headers 封顶)伸缩补偿
// 写入走 tmp+rename(运行中二进制直接写会 ETXTBSY); 首次写入前备份 .retry-bak

function opencodeBinaries(): string[] {
  const out = new Set<string>()
  try {
    out.add(process.execPath)
  } catch {}
  // execPath 形如 <pkg>/bin/opencode(.exe) 或 <pkg>/node_modules/opencode-<platform>/bin/opencode
  // 平台包在 <pkg>/node_modules/ 下, 从两层候选根各自 glob 一遍
  for (const root of [
    path.dirname(path.dirname(process.execPath)), // <pkg>
    path.dirname(path.dirname(path.dirname(process.execPath))), // <pkg> 的上级(含 <pkg> 自身)
  ]) {
    try {
      for (const dir of readdirSync(path.join(root, "node_modules"))) {
        if (!dir.startsWith("opencode-")) continue
        for (const name of ["opencode", "opencode.exe"]) {
          const bin = path.join(root, "node_modules", dir, "bin", name)
          if (existsSync(bin)) out.add(bin)
        }
      }
    } catch {}
  }
  return [...out]
}

type RetryChain = {
  spanStart: number // ",TH=30000,DH=2147483647,RV=5" 的起始偏移(含前导逗号)
  span: string // 该段原文
  retryVar: string
  retryVal: string
}

const MAX_DELAY_ANCHOR = "=2147483647,"

function findRetryChain(buf: Buffer): RetryChain | undefined {
  let idx = buf.indexOf(MAX_DELAY_ANCHOR)
  while (idx !== -1) {
    const after = buf
      .slice(idx + MAX_DELAY_ANCHOR.length, idx + MAX_DELAY_ANCHOR.length + 24)
      .toString("latin1")
    // 锚点后紧跟: RV=NUM,
    const m = after.match(/^([A-Za-z_$][\w$]{0,2})=(\d{1,3}),/)
    if (m) {
      // 锚点前(不含锚点的'='): ,TH=NUM,DH  —— 切片止于 DH 变量名, 无 '='
      const beforeStart = Math.max(0, idx - 40)
      const before = buf.slice(beforeStart, idx).toString("latin1")
      const mb = before.match(/,([A-Za-z_$][\w$]{0,2})=(\d{2,6}),([A-Za-z_$][\w$]{0,2})$/)
      if (mb) {
        const spanStart = beforeStart + mb.index!
        const spanEnd = idx + MAX_DELAY_ANCHOR.length + m[0].length - 1 // 去掉尾逗号
        const span = buf.slice(spanStart, spanEnd).toString("latin1")
        return { spanStart, span, retryVar: m[1], retryVal: m[2] }
      }
    }
    idx = buf.indexOf(MAX_DELAY_ANCHOR, idx + 1)
  }
  return undefined
}

// 已打"无限"补丁的标记: .attempt< 后跟 -1/1 + 空格填充 + )
function hasUnlimitedPatch(buf: Buffer): boolean {
  const idx = buf.indexOf(".attempt<")
  if (idx === -1) return false
  return /^\.attempt<(?:-1|1)\s{0,2}\)/.test(buf.slice(idx, idx + 16).toString("latin1"))
}

// 等长构造"无限"比较式: ">RV)" → "<body )" (body=-1 或 1, 空格补齐)
function unlimitedReplacement(retryVar: string): string | undefined {
  const total = 1 + retryVar.length + 1 // ">RV)" 的长度
  const body = retryVar.length >= 2 ? "-1" : "1"
  let rep = `<${body})`
  while (rep.length < total) rep = rep.slice(0, -1) + " )"
  return rep.length === total ? rep : undefined
}

// 等长改写常量链: th(退避封顶)/yh(重试次数) 设为目标值, 位数差由 dh 吸收。
// dh 只允许缩到 999999999(9 位, ≈11.6 天), 仍高于一切现实的 retry-after 注入等待
// (智谱 5h 窗口 ≈ 18M ms, 火山月度重置 ≈ 111M ms), 注入值不受影响。
// 装不下(如 6 位封顶 + 2-3 位次数)返回 undefined, 调用方提示用户
function rewriteSpan(chain: RetryChain, th: number, yh: number): string | undefined {
  const m = chain.span.match(
    /^,([A-Za-z_$][\w$]{0,2})=\d{2,6},([A-Za-z_$][\w$]{1,3})=(\d{9,10}),([A-Za-z_$][\w$]{0,2})=\d{1,3}$/,
  )
  if (!m) return undefined
  const [, thVar, dhVar, dhVal, yhVar] = m
  const build = (dh: string) => `,${thVar}=${th},${dhVar}=${dh},${yhVar}=${yh}`
  if (build(dhVal).length === chain.span.length) return build(dhVal)
  if (dhVal.length === 10 && build("999999999").length === chain.span.length) return build("999999999")
  return undefined
}

type PatchStatus = "patched" | "already" | "notfound" | "conflict" | "invalid"

type PatchOpts = { maxRetries?: number; backoffCapMs?: number }

function patchBinary(bin: string, opts: PatchOpts): PatchStatus {
  const buf = readFileSync(bin)
  let touched = false

  const chain = findRetryChain(buf)
  if (!chain) return "notfound"
  const cmpOffset = buf.indexOf(`.attempt>${chain.retryVar})`)

  // --- 常量链改写: th(退避封顶)/yh(重试次数) ---
  const cur = chain.span.match(
    /^,[A-Za-z_$][\w$]{0,2}=(\d{2,6}),[A-Za-z_$][\w$]{1,3}=\d{9,10},[A-Za-z_$][\w$]{0,2}=(\d{1,3})$/,
  )
  if (!cur) return "notfound"
  const thTarget = opts.backoffCapMs ?? Number(cur[1])
  const yhTarget = opts.maxRetries !== undefined && opts.maxRetries > 0 ? opts.maxRetries : Number(cur[2])
  if (thTarget !== Number(cur[1]) || yhTarget !== Number(cur[2])) {
    // 改次数需要比较点完好(已被无限补丁改写则冲突); 只改封顶不冲突
    if (yhTarget !== Number(cur[2]) && cmpOffset === -1) return "conflict"
    const newSpan = rewriteSpan(chain, thTarget, yhTarget)
    if (!newSpan) return "invalid"
    writePatched(bin, buf, [{ at: chain.spanStart, from: chain.span, to: newSpan }])
    touched = true
  }

  // --- 无限次数: 比较点 .attempt>RV) 改恒假 ---
  if (opts.maxRetries === -1 && !hasUnlimitedPatch(buf)) {
    if (cmpOffset === -1) return touched ? "patched" : "notfound"
    const rep = unlimitedReplacement(chain.retryVar)
    if (!rep) return touched ? "patched" : "notfound"
    writePatched(bin, buf, [{ at: cmpOffset + ".attempt".length, from: `>${chain.retryVar})`, to: rep }])
    touched = true
  }

  // --- 退避封顶: 无 retry-after 分支落体到 Math.min(eh,th) ---
  if (opts.backoffCapMs !== undefined && !hasBackoffCap(buf)) {
    const site = findBackoffSite(buf)
    if (!site) return touched ? "patched" : "notfound"
    writePatched(bin, buf, [{ at: site.at, from: site.from, to: semicolons(site.from.length) }])
    touched = true
  }

  return touched ? "patched" : "already"
}

// ===== 退避封顶补丁: 有 responseHeaders 但无 retry-after 的分支 =====
// 原码: ...return cl(Math.ceil(f))}return cl(eh(e,l))}}return cl(Math.min(eh(e,l),th))
//   前者(headers 存在但无 retry-after 值)指数退避无封顶(实测 38s/76s 一路翻倍到 24.8 天)
// 改法: 等长替换为空语句(18 个分号), 控制流落到函数末尾
//   return cl(Math.min(eh(e,l),th)) —— 与无 headers 分支共用 30s 封顶
// retry-after / retry-after-ms 注入路径在前面提前 return, 不经过此处, 等待值不受影响

const BACKOFF_RETURN_RE = /return [a-z_$]{1,3}\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\)\)\}\}return [a-z_$]{1,3}\(Math\.min\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\),[a-z_$]{1,3}\)\)/

type BackoffSite = { at: number; from: string }

function findBackoffSite(buf: Buffer): BackoffSite | undefined {
  // 在 retry 常量链之后 2KB 内找 "return XX(YY(a,b))}}" 且后面紧跟 "return XX(Math.min(...))"
  const anchor = buf.indexOf(MAX_DELAY_ANCHOR)
  if (anchor === -1) return undefined
  const seg = buf.slice(anchor, anchor + 2048).toString("latin1")
  const m = seg.match(BACKOFF_RETURN_RE)
  if (!m) return undefined
  // 只替换开头的 return XX(YY(a,b)) 部分, }} 保留(否则块结构被破坏)
  const head = m[0].match(/^return [a-z_$]{1,3}\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\)\)/)!
  return { at: anchor + m.index!, from: head }
}

// 已打封顶补丁的检测: 常量链窗口内出现连续分号(原 return 语句被替换)后紧跟 return XX(Math.min
function hasBackoffCap(buf: Buffer): boolean {
  const anchor = buf.indexOf(MAX_DELAY_ANCHOR)
  if (anchor === -1) return false
  const seg = buf.slice(anchor, anchor + 2048).toString("latin1")
  return /;{12,}\}\}return [a-z_$]{1,3}\(Math\.min/.test(seg)
}

function semicolons(n: number): string {
  return ";".repeat(n)
}

// macOS 要求二进制有代码签名(至少 ad-hoc); 修改字节后签名失效,
// arm64 上内核会直接 SIGKILL。改完必须重签(/usr/bin/codesign 系统自带, 无需证书)
function codesignAdHoc(bin: string): boolean {
  if (process.platform !== "darwin") return true
  try {
    execFileSync("codesign", ["-f", "-s", "-", bin], { stdio: "ignore", timeout: 60_000 })
    return true
  } catch {
    return false
  }
}

function writePatched(bin: string, buf: Buffer, edits: Array<{ at: number; from: string; to: string }>) {
  for (const e of edits) {
    if (buf.slice(e.at, e.at + e.from.length).toString("latin1") !== e.from) throw new Error(`patch verify fail at ${e.at}`)
    buf.write(e.to, e.at, "latin1")
  }
  const bak = `${bin}.retry-bak`
  if (!existsSync(bak)) copyFileSync(bin, bak)
  const tmp = `${bin}.retry-patch-tmp`
  writeFileSync(tmp, buf)
  chmodSync(tmp, 0o755)
  renameSync(tmp, bin)
  if (!codesignAdHoc(bin)) throw new Error("codesign failed (macOS)")
}

function restoreBinary(bin: string): boolean {
  const bak = `${bin}.retry-bak`
  if (!existsSync(bak)) return false
  const tmp = `${bin}.retry-restore-tmp`
  copyFileSync(bak, tmp)
  chmodSync(tmp, 0o755)
  renameSync(tmp, bin)
  codesignAdHoc(bin)
  return true
}

function runPatch(cfg: PatchConfig, notify: (title: string, message: string, variant?: "info" | "warning") => void) {
  if (cfg.restore) {
    let n = 0
    for (const bin of opencodeBinaries()) {
      try {
        if (restoreBinary(bin)) n++
      } catch {}
    }
    notify("quota-retry 补丁", n > 0 ? `已还原 ${n} 个二进制(来自 .retry-bak)` : "未找到备份, 无需还原")
    return
  }
  const maxRetries = cfg.maxRetries ?? -1
  if (maxRetries !== -1 && !(maxRetries >= 1 && maxRetries <= 999)) {
    notify("quota-retry 补丁", "maxRetries 仅支持 -1(无限) 或 1-999", "warning")
    return
  }
  const cap = cfg.backoffCapMs
  if (cap !== undefined && !(cap >= 10_000 && cap <= 999_999)) {
    notify("quota-retry 补丁", "backoffCapMs 仅支持 10000-999999 (10s 到 16.6 分钟)", "warning")
    return
  }
  const label = [
    `重试上限 ${maxRetries === -1 ? "无限" : maxRetries}`,
    cap ? `退避封顶 ${cap / 1000}s` : "",
  ]
    .filter(Boolean)
    .join(", ")
  for (const bin of opencodeBinaries()) {
    try {
      const r = patchBinary(bin, { maxRetries, backoffCapMs: cap })
      if (r === "patched") notify("quota-retry 补丁", `${label} 已写入 (${path.basename(bin)}), 下次启动生效`)
      else if (r === "already") notify("quota-retry 补丁", `已是目标状态, 跳过 (${path.basename(bin)})`)
      else if (r === "conflict")
        notify("quota-retry 补丁", `当前为无限补丁, 改指定次数请先 restore (${path.basename(bin)})`, "warning")
      else if (r === "invalid")
        notify(
          "quota-retry 补丁",
          `位数装不下: 退避封顶(6 位数)与重试次数(2-3 位数)不能同时设置, 请二选一调小 (${path.basename(bin)})`,
          "warning",
        )
      else notify("quota-retry 补丁", `未找到重试常量链, opencode 版本可能已大改, 跳过 (${path.basename(bin)})`, "warning")
    } catch (e) {
      const msg = (e as Error).message.includes("codesign")
        ? `补丁已写入但重签名失败, macOS 下可能无法启动, 请手动执行 codesign -f -s -`
        : `写入失败: ${(e as Error).message}`
      notify("quota-retry 补丁", `${msg} (${path.basename(bin)})`, "warning")
    }
  }
}

// 从 429 body 提取重置时刻(捕获组 1 = 完整时间串); 无时区后缀按 +08:00 解析。
// 返回绝对毫秒时间戳, 解析失败返回 NaN
function parseExtractedTime(m: RegExpMatchArray | null): number {
  const s = m?.[1]
  if (!s) return Number.NaN
  const base = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s.replace(" ", "T")}+08:00`
  return Date.parse(base)
}

export default async function (input: { directory?: string; client?: any }) {
  const pluginConfig = loadConfig(input.directory ?? process.cwd())
  const toastClient = input.client
  const toast = (title: string, message: string, variant: "info" | "warning" = "info") => {
    try {
      toastClient?.tui?.showToast?.({ body: { title, message, variant, duration: 5000 } })
    } catch {}
  }
  if (pluginConfig.syncEnabled !== false) {
    syncPlugin(pluginConfig.repo ?? REPO, toast).catch(() => {})
  }
  const patch = pluginConfig.patch
  if (patch?.restore) runPatch({ restore: true }, toast)
  else if (patch?.enabled) runPatch(patch, toast)
  const quotaCacheMs = pluginConfig.quotaCacheMs ?? DEFAULT_QUOTA_CACHE_MS
  // 缓存绝对重置时刻(而非相对 wait), 使用时再算差值, 避免缓存值随时间过期
  const cache = new Map<string, { at: number; resetAt: number }>()

  let lastPassthroughToast = 0

  async function getZhipuResetMs(p: ProviderConfig, apiKey: string): Promise<number> {
    const hit = cache.get(p.id)
    if (hit && Date.now() - hit.at < quotaCacheMs) return hit.resetAt - Date.now()
    const quotaUrl = p.quotaUrl ?? DEFAULT_QUOTA_URL
    const resetAt = await (async () => {
      try {
        const res = await fetch(quotaUrl, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (!res.ok) return Number.NaN
        const body = (await res.json()) as {
          data?: { limits?: Array<{ percentage?: number; remaining?: number; nextResetTime?: number }> }
        }
        const limits = body?.data?.limits ?? []
        const exhausted = limits.filter((l) => (l.percentage ?? 0) >= 100 || (l.remaining ?? 1) <= 0)
        if (exhausted.length === 0) return Number.NaN
        const reset = Math.min(...exhausted.map((l) => l.nextResetTime ?? Infinity))
        return Number.isFinite(reset) ? reset : Number.NaN
      } catch {
        return Number.NaN
      }
    })()
    cache.set(p.id, { at: Date.now(), resetAt })
    return resetAt - Date.now()
  }

  function makeFetch(p: ProviderConfig) {
    const configuredKey = p.apiKey
    const fallbackWaitMs = p.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS
    const bufferMs = p.bufferMs ?? DEFAULT_BUFFER_MS
    // 两组正则: quotaMatch 判定是不是配额 429; resetExtract 提取重置时刻
    const quotaMatch = new RegExp(p.quotaMatch ?? DEFAULT_QUOTA_MATCH, "i")
    const resetExtract = p.resetExtract ? new RegExp(p.resetExtract, "i") : new RegExp(DEFAULT_RESET_EXTRACT, "i")
    const extractFromBody = (text: string): number => parseExtractedTime(text.match(resetExtract)) - Date.now()
    return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await fetch(url, init)
      if (res.status !== 429) return res
      const text = await res.text()
      const headers = Object.fromEntries(res.headers)
      if (!quotaMatch.test(text)) {
        // 没匹配上配额特征: 不注入, 原样交还 opencode 原生指数退避
        if (Date.now() - lastPassthroughToast > 300_000) {
          lastPassthroughToast = Date.now()
          toast(`${p.id} 限流`, "429 非配额耗尽(如并发限流), 走 opencode 原生重试", "info")
        }
        return new Response(text, { status: res.status, statusText: res.statusText, headers })
      }
      // 确认配额耗尽: token 优先取请求头(实际使用的 key), 其次 config, 最后 auth.json
      const apiKey = extractBearerFromInit(init) ?? configuredKey ?? readApiKey(p.id)
      let waitMs = Number.NaN
      if (p.quota === "zhipu") {
        if (apiKey) waitMs = await getZhipuResetMs(p, apiKey)
        if (Number.isNaN(waitMs)) waitMs = extractFromBody(text)
      } else {
        waitMs = extractFromBody(text)
      }
      if (Number.isFinite(waitMs) && waitMs > 0) {
        waitMs += bufferMs
        const minutes = waitMs / 60_000
        const waitText =
          minutes >= 60 ? `约 ${Math.round(minutes / 60)} 小时` : minutes >= 1 ? `约 ${Math.round(minutes)} 分钟` : "不到 1 分钟"
        toast(`${p.id} 配额耗尽`, `等待${waitText}后自动重试`, "warning")
      } else {
        // 已知配额耗尽但拿不到精确重置时间(API 失败且 body 无时间戳), 才用 fallback
        waitMs = fallbackWaitMs
        toast(`${p.id} 配额耗尽`, "重置时间未知, 按 fallbackWaitMs 重试", "warning")
      }
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: { ...headers, "retry-after-ms": String(Math.ceil(waitMs)) },
      })
    }
  }

  return {
    config: (cfg: any) => {
      if (!pluginConfig.providers || pluginConfig.providers.length === 0) return
      cfg.provider = cfg.provider ?? {}
      for (const p of pluginConfig.providers) {
        if (!p || !p.id) continue
        const existing = cfg.provider[p.id] ?? {}
        cfg.provider[p.id] = {
          ...existing,
          options: { ...(existing.options ?? {}), fetch: makeFetch(p) },
        }
      }
    },
  }
}
