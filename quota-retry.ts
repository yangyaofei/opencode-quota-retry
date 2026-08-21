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
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
    // toast 必须延迟(同 opencode-acp update.ts): 此刻仍在 opencode bootstrap 期,
    // TUI 尚未挂载完成, 立即发的 toast 会直接丢失
    setTimeout(() => {
      notify("quota-retry 已同步", "检测到新版本, 旧副本已删除, 重启 opencode 生效")
    }, 5000)
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
  // execPath 形如 <pkg>/bin/opencode(.exe) 或 <pkg>/node_modules/opencode-<platform>/bin/opencode。
  // 只认名字是 opencode 的可执行文件: 插件被非 opencode 进程加载时(如测试 harness 的 node),
  // execPath=node, 不能把它当补丁目标, 否则状态清理会误删全部记录
  const exec = process.execPath
  const execBase = path.basename(exec)
  if (execBase === "opencode" || execBase === "opencode.exe") out.add(exec)
  // 平台包在 <pkg>/node_modules/ 下, 从两层候选根各自 glob 一遍
  for (const root of [
    path.dirname(path.dirname(exec)), // <pkg>
    path.dirname(path.dirname(path.dirname(exec))), // <pkg> 的上级(含 <pkg> 自身)
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

// 锚点双值: 出厂绝对上限 2147483647, 以及位吸收后的 999999999
// (改过次数后 dh 不再是出厂值, 单一锚点会找不到自己打过补丁的链)
const MAX_DELAY_ANCHORS = ["=2147483647,", "=999999999,"]

function findRetryChain(buf: Buffer): RetryChain | undefined {
  for (const anchor of MAX_DELAY_ANCHORS) {
    let idx = buf.indexOf(anchor)
    while (idx !== -1) {
      const after = buf
        .slice(idx + anchor.length, idx + anchor.length + 24)
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
          const spanEnd = idx + anchor.length + m[0].length - 1 // 去掉尾逗号
          const span = buf.slice(spanStart, spanEnd).toString("latin1")
          return { spanStart, span, retryVar: m[1], retryVal: m[2] }
        }
      }
      idx = buf.indexOf(anchor, idx + 1)
    }
  }
  return undefined
}

// 从"已打补丁"的二进制反推"功能上的出厂态"(仅用于备份过期/丢失时重建备份):
// 两个补丁标记都是等长替换, 逆向等长换回即可——
//   无限标记  .attempt<-1)  →  .attempt>RV)     (RV 从常量链取, 变量名 1-2 位时等长)
//   封顶分号  ;;;;;...      →  return XX(YY(a,b))  (函数/变量名从紧随其后的
//                              return XX(Math.min(YY(a,b),TH)) 尾巴里取, 等长)
// 常量链保持原样(本来就是出厂值时字节精确; 改过次数时功能等价)。
// 返回 null 表示任一步无法等长还原(版本结构变化), 调用方按 conflict 处理
function synthesizePristine(buf: Buffer, chain: RetryChain): Buffer | null {
  const out = Buffer.from(buf)
  // 1. 反转无限标记
  const mIdx = out.indexOf(".attempt<")
  if (mIdx !== -1) {
    const seg = out.slice(mIdx, mIdx + 16).toString("latin1")
    const m = seg.match(/^\.attempt<(?:-1|1)(\s{0,2})\)/)
    if (!m) return null
    const back = `.attempt>${chain.retryVar})`
    if (back.length !== m[0].length) return null
    out.write(back, mIdx, "latin1")
  }
  // 2. 反转封顶分号: ;;;;..}}return XX(Math.min(YY(a,b),TH)) → 分号换回 return XX(YY(a,b))
  const win = backoffWindow(out, chain)
  const m2 = win.match(/;{12,}\}\}return ([a-z_$]{1,3})\(Math\.min\(([a-z_$]{1,3})\(([a-z_$]{1,3}),([a-z_$]{1,3})\),[a-z_$]{1,3}\)/)
  if (m2) {
    const head = `return ${m2[1]}(${m2[2]}(${m2[3]},${m2[4]}))`
    const semis = m2[0].match(/^;+/)![0].length
    if (head.length !== semis) return null
    const at = chain.spanStart + chain.span.length + m2.index!
    out.write(head, at, "latin1")
  }
  return out
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
  // 注意: 数字部分不加捕获括号, 保证 m[1]/m[2]/m[3] 恰为三个变量名
  // (曾因 (\d{9,10}) 多一对括号导致解构错位, yhVar 拿到数字, 场景 C 失败的真根因)
  const m = chain.span.match(
    /^,([A-Za-z_$][\w$]{0,2})=\d{2,6},([A-Za-z_$][\w$]{1,3})=\d{9,10},([A-Za-z_$][\w$]{0,2})=\d{1,3}$/,
  )
  if (!m) return undefined
  const [, thVar, dhVar, yhVar] = m
  // dh 双向伸缩: 优先恢复出厂绝对上限, 装不下则收缩到 999999999
  const build = (dh: string) => `,${thVar}=${th},${dhVar}=${dh},${yhVar}=${yh}`
  for (const dh of ["2147483647", "999999999"]) {
    if (build(dh).length === chain.span.length) return build(dh)
  }
  return undefined
}

type PatchStatus = "patched" | "already" | "notfound" | "conflict" | "invalid"

type PatchOpts = { maxRetries?: number; backoffCapMs?: number }

const CHAIN_VALS_RE = /^,[A-Za-z_$][\w$]{0,2}=(\d{2,6}),[A-Za-z_$][\w$]{1,3}=\d{9,10},[A-Za-z_$][\w$]{0,2}=(\d{1,3})$/

function patchBinary(bin: string, opts: PatchOpts): PatchStatus {
  let buf = readFileSync(bin)
  let chain = findRetryChain(buf)
  if (!chain) return "notfound"

  const cur0 = chain.span.match(CHAIN_VALS_RE)
  if (!cur0) return "notfound"

  // 备份新鲜度: 等长补丁 size 恒不变, size 不同 = 跨版本旧备份。
  // 备份过期/丢失时: 当前二进制无补丁标记 → 它本身就是出厂态;
  // 带补丁标记 → 从当前二进制反推(等长逆向)重建一份功能出厂态备份
  const bak = `${bin}.retry-bak`
  const bakStale = existsSync(bak) && statSync(bak).size !== statSync(bin).size
  const pristine = (() => {
    if (!bakStale && existsSync(bak)) {
      const b = findRetryChain(readFileSync(bak))
      return b ? { chain: b, src: readFileSync(bak) } : undefined
    }
    if (!hasUnlimitedPatch(buf) && !hasBackoffCap(buf, chain)) {
      if (bakStale) writeBak(bin, buf) // 无标记 = 出厂态, 直接以它重建备份
      return { chain, src: buf }
    }
    const syn = synthesizePristine(buf, chain)
    if (!syn) return undefined
    const synChain = findRetryChain(syn)
    if (!synChain || hasUnlimitedPatch(syn) || hasBackoffCap(syn, synChain)) return undefined
    writeBak(bin, syn)
    return { chain: synChain, src: syn }
  })()
  if (!pristine) {
    rmSync(bak, { force: true }) // 不可用的备份不如没有
    return "conflict"
  }
  const pvals = pristine.chain.span.match(CHAIN_VALS_RE)
  if (!pvals) return "notfound"

  // 期望态: 显式配置优先, 未配置的轴 = 出厂值
  const want = {
    unlimited: opts.maxRetries === -1,
    yh: opts.maxRetries !== undefined && opts.maxRetries > 0 ? opts.maxRetries : Number(pvals[2]),
    th: opts.backoffCapMs ?? Number(pvals[1]),
    cap: opts.backoffCapMs !== undefined,
  }

  // 已在目标态: 不动二进制(次数在无限模式下是死代码, 不比较; 过期备份已在上面重建)
  const sameState =
    hasUnlimitedPatch(buf) === want.unlimited &&
    (want.unlimited || Number(cur0[2]) === want.yh) &&
    (want.cap ? Number(cur0[1]) === want.th : !hasBackoffCap(buf, chain))
  if (sameState) return "already"

  // 需要动手: 一律回到出厂态再整体重打, 不做任意历史布局间的增量改写
  if (bakStale || existsSync(bak)) {
    if (!restoreBinary(bin)) return "conflict"
    buf = readFileSync(bin)
    chain = findRetryChain(buf)
    if (!chain) return "notfound"
  }

  // 从出厂态一次性应用全部补丁(单次写入/重命名/重签名)
  const fvals = chain.span.match(CHAIN_VALS_RE)
  if (!fvals) return "notfound"
  const edits: Array<{ at: number; from: string; to: string }> = []
  if (want.th !== Number(fvals[1]) || want.yh !== Number(fvals[2])) {
    const newSpan = rewriteSpan(chain, want.th, want.yh)
    if (!newSpan) return "invalid"
    edits.push({ at: chain.spanStart, from: chain.span, to: newSpan })
  }
  if (want.unlimited) {
    const at = buf.indexOf(`.attempt>${chain.retryVar})`)
    if (at === -1) return "notfound"
    const rep = unlimitedReplacement(chain.retryVar)
    if (!rep) return "notfound"
    edits.push({ at: at + ".attempt".length, from: `>${chain.retryVar})`, to: rep })
  }
  if (want.cap) {
    const site = findBackoffSite(buf, chain)
    if (!site) return "notfound"
    edits.push({ at: site.at, from: site.from, to: semicolons(site.from.length) })
  }
  if (edits.length === 0) return "already"
  writePatched(bin, buf, edits)
  return "patched"
}

// 备份写入: tmp + rename 原子替换(内容可能是合成的出厂态 Buffer)
function writeBak(bin: string, content: Buffer) {
  const tmp = `${bin}.retry-bak-tmp`
  try {
    writeFileSync(tmp, content)
    chmodSync(tmp, 0o755)
    renameSync(tmp, `${bin}.retry-bak`)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

// ===== 退避封顶补丁: 有 responseHeaders 但无 retry-after 的分支 =====
// 原码: ...return cl(Math.ceil(f))}return cl(eh(e,l))}}return cl(Math.min(eh(e,l),th))
//   前者(headers 存在但无 retry-after 值)指数退避无封顶(实测 38s/76s 一路翻倍到 24.8 天)
// 改法: 等长替换为空语句(18 个分号), 控制流落到函数末尾
//   return cl(Math.min(eh(e,l),th)) —— 与无 headers 分支共用 30s 封顶
// retry-after / retry-after-ms 注入路径在前面提前 return, 不经过此处, 等待值不受影响

const BACKOFF_RETURN_RE = /return [a-z_$]{1,3}\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\)\)\}\}return [a-z_$]{1,3}\(Math\.min\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\),[a-z_$]{1,3}\)\)/

type BackoffSite = { at: number; from: string }

// delay 函数紧跟在常量链之后: 从 chain 尾部起取窗口(不能 indexOf 锚点,
// 二进制里第一处 =2147483647, 是无关的 kMaxLength)
function backoffWindow(buf: Buffer, chain: RetryChain): string {
  const start = chain.spanStart + chain.span.length
  return buf.slice(start, start + 2048).toString("latin1")
}

function findBackoffSite(buf: Buffer, chain: RetryChain): BackoffSite | undefined {
  // 窗口内找 "return XX(YY(a,b))}}" 且后面紧跟 "return XX(Math.min(...))"
  const seg = backoffWindow(buf, chain)
  const m = seg.match(BACKOFF_RETURN_RE)
  if (!m) return undefined
  // 只替换开头的 return XX(YY(a,b)) 部分, }} 保留(否则块结构被破坏)
  const head = m[0].match(/^return [a-z_$]{1,3}\([a-z_$]{1,3}\([a-z_$]{1,3},[a-z_$]{1,3}\)\)/)![0]
  return { at: chain.spanStart + chain.span.length + m.index!, from: head }
}

// 已打封顶补丁的检测: 窗口内出现连续分号(原 return 语句被替换)后紧跟 return XX(Math.min
function hasBackoffCap(buf: Buffer, chain: RetryChain): boolean {
  return /;{12,}\}\}return [a-z_$]{1,3}\(Math\.min/.test(backoffWindow(buf, chain))
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
  try {
    writeFileSync(tmp, buf)
    chmodSync(tmp, 0o755)
    renameSync(tmp, bin)
  } catch (e) {
    rmSync(tmp, { force: true }) // 失败不留残片(曾因 ENOSPC 留下半写文件占满磁盘)
    throw e
  }
  if (!codesignAdHoc(bin)) throw new Error("codesign failed (macOS)")
}

function restoreBinary(bin: string): boolean {
  const bak = `${bin}.retry-bak`
  if (!existsSync(bak)) return false
  const tmp = `${bin}.retry-restore-tmp`
  try {
    copyFileSync(bak, tmp)
    chmodSync(tmp, 0o755)
    renameSync(tmp, bin)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  codesignAdHoc(bin)
  return true
}

// ===== 补丁状态缓存 =====
// 每次启动对 3 份 ~184MB 二进制做 readFileSync+全量扫描代价高(首次实测拖慢启动)。
// 补丁是 (二进制内容, 配置) 的确定函数, 用 size+mtimeMs+目标 描述"已做过什么",
// 命中即跳过读盘与写入; npm 升级换文件/配置变更 → stat 变化 → 自动失效重做。
type PatchStateEntry = { size: number; mtimeMs: number; want: string }

function patchStateFile(): string {
  return path.join(homedir(), ".cache", "opencode", "quota-retry-patch-state.json")
}

function loadPatchState(): Record<string, PatchStateEntry> {
  try {
    const parsed = JSON.parse(readFileSync(patchStateFile(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function savePatchState(state: Record<string, PatchStateEntry>) {
  try {
    mkdirSync(path.dirname(patchStateFile()), { recursive: true })
    writeFileSync(patchStateFile(), JSON.stringify(state, null, 2))
  } catch {}
}

function binStat(bin: string): { size: number; mtimeMs: number } | undefined {
  try {
    const st = statSync(bin)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

function runPatch(cfg: PatchConfig, notify: (title: string, message: string, variant?: "info" | "warning") => void) {
  const restore = cfg.restore === true
  const maxRetries = cfg.maxRetries ?? -1
  const cap = cfg.backoffCapMs

  // 入口校验: 范围 + 等长替换位预算组合, 无效即 toast 并整体跳过
  if (!restore) {
    const v = validatePatchConfig(cfg)
    if (!v.ok) {
      notify("quota-retry 补丁", v.reason!, "warning")
      return
    }
  }

  const want = restore ? "restore" : `maxRetries=${maxRetries},cap=${cap ?? "-"}`
  const label = [
    `重试上限 ${maxRetries === -1 ? "无限" : maxRetries}`,
    cap ? `退避封顶 ${cap / 1000}s` : "",
  ]
    .filter(Boolean)
    .join(", ")

  const bins = opencodeBinaries()
  const state = loadPatchState()
  let changed = false
  for (const bin of bins) {
    const st = binStat(bin)
    if (!st) continue
    // 幂等跳过: 同二进制同目标 → 不读盘不写入不 toast
    const hit = state[bin]
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.want === want) continue

    let ok = false
    try {
      if (restore) {
        const r = restoreBinary(bin)
        if (r) notify("quota-retry 补丁", `已还原出厂 (${path.basename(bin)})`)
        ok = true
      } else {
        const r = patchBinary(bin, { maxRetries, backoffCapMs: cap })
        if (r === "patched") notify("quota-retry 补丁", `${label} 已写入 (${path.basename(bin)}), 下次启动生效`)
        else if (r === "conflict")
          notify("quota-retry 补丁", `需拆除已打补丁但找不到 .retry-bak 备份, 请重装 opencode 后重启 (${path.basename(bin)})`, "warning")
        else if (r === "invalid")
          notify("quota-retry 补丁", `位数装不下: 封顶与次数组合超出等长预算 (${path.basename(bin)})`, "warning")
        else if (r === "notfound")
          notify("quota-retry 补丁", `未找到重试常量链, opencode 版本可能已大改, 跳过 (${path.basename(bin)})`, "warning")
        // "already" 静默: 状态文件缺失但二进制已是目标, 记入状态即可
        ok = r === "patched" || r === "already"
      }
    } catch (e) {
      const msg = (e as Error).message.includes("codesign")
        ? `补丁已写入但重签名失败, 请手动执行 codesign -f -s -`
        : `写入失败: ${(e as Error).message}`
      notify("quota-retry 补丁", `${msg} (${path.basename(bin)})`, "warning")
    }
    if (ok) {
      const after = binStat(bin) ?? st
      state[bin] = { ...after, want }
      changed = true
    }
  }
  // 清理已消失的二进制(如 npm 卸载平台包); 一份都没探测到时不清理
  // (非 opencode 进程加载本插件时 bins 为空, 此时清空状态 = 误删)
  if (bins.length > 0) {
    for (const k of Object.keys(state)) {
      if (!bins.includes(k)) {
        delete state[k]
        changed = true
      }
    }
  }
  if (changed) savePatchState(state)
}

// ===== /retry-setting 状态查询 =====

// 入口校验(runPatch 与状态报告共用): 范围 + 等长替换位预算组合
function validatePatchConfig(cfg: PatchConfig): { ok: boolean; reason?: string } {
  if (cfg.restore === true) return { ok: true }
  const maxRetries = cfg.maxRetries ?? -1
  const cap = cfg.backoffCapMs
  if (maxRetries !== -1 && !(Number.isInteger(maxRetries) && maxRetries >= 1 && maxRetries <= 99)) {
    return { ok: false, reason: "maxRetries 仅支持 -1(无限) 或 1-99" }
  }
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 10_000 && cap <= 999_999)) {
    return { ok: false, reason: "backoffCapMs 仅支持 10000-999999 (10s 到 16.6 分钟)" }
  }
  if (cap !== undefined && cap >= 100_000 && maxRetries >= 10 && maxRetries !== -1) {
    return { ok: false, reason: "backoffCapMs ≥ 100s(6 位数)时 maxRetries 仅支持 -1 或 1-9 (等长替换位预算)" }
  }
  return { ok: true }
}

// 实际生效的配置文件路径(项目 .opencode/ 优先于全局)
function findConfigFile(projectDir: string): string {
  const candidates = [path.join(projectDir, ".opencode", "quota-retry.jsonc"), globalConfigPath()]
  for (const f of candidates) if (existsSync(f)) return f
  return globalConfigPath()
}

function describePatchConfig(patch: PatchConfig): string {
  const parts = [`enabled=${patch.enabled ?? false}`]
  if (patch.maxRetries !== undefined) parts.push(`maxRetries=${patch.maxRetries}${patch.maxRetries === -1 ? "(无限)" : ""}`)
  if (patch.backoffCapMs !== undefined) parts.push(`backoffCapMs=${patch.backoffCapMs}`)
  if (patch.restore !== undefined) parts.push(`restore=${patch.restore}`)
  return parts.join(" | ")
}

// 只读对照报告: 配置期望 vs 二进制实际(不写盘, 不 toast, 不触发同步)。
// bins 参数供脱离 opencode 进程的测试注入; 缺省自动探测
function patchStatusReport(projectDir: string, binsOverride?: string[]): string {
  const lines: string[] = []
  const cfg = loadConfig(projectDir)
  const patch = cfg.patch ?? {}
  lines.push(`配置文件: ${findConfigFile(projectDir)}`)

  if (cfg.providers?.length) {
    lines.push("providers(429 拦截):")
    for (const p of cfg.providers) {
      if (!p?.id) continue
      const parts = [p.id, `配额判定=${p.quota}`]
      parts.push(p.quotaMatch ? "quotaMatch=自定义" : "quotaMatch=内置默认")
      parts.push(p.resetExtract ? "resetExtract=自定义" : "resetExtract=内置默认")
      parts.push(`fallbackWaitMs=${p.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS}`)
      parts.push(`bufferMs=${p.bufferMs ?? DEFAULT_BUFFER_MS}`)
      lines.push(`  - ${parts.join(", ")}`)
    }
  } else {
    lines.push("providers(429 拦截): 未配置")
  }

  const enabled = patch.enabled === true || patch.restore === true
  lines.push(`patch 配置: ${enabled ? describePatchConfig(patch) : "未启用"}`)
  let active = false
  if (!enabled) {
    lines.push("  patch.enabled 未开启: 启动时不检查也不改动二进制, 以下为当前实际状态")
  } else {
    const v = validatePatchConfig(patch)
    active = v.ok
    lines.push(`入口校验: ${v.ok ? "通过" : `未通过 — ${v.reason} (启动时补丁整体跳过)`}`)
  }

  const bins = binsOverride ?? opencodeBinaries()
  const state = loadPatchState()
  if (bins.length === 0) lines.push("opencode 二进制: 未找到(当前进程不是 opencode)")
  bins.forEach((bin, i) => {
    lines.push(`二进制 ${i + 1}/${bins.length}: ${bin}`)
    let buf: Buffer
    try {
      buf = readFileSync(bin)
    } catch (e) {
      lines.push(`  读取失败: ${(e as Error).message}`)
      return
    }
    const chain = findRetryChain(buf)
    if (!chain) {
      lines.push("  未找到重试常量链(opencode 版本可能已大改)")
      return
    }
    const cur = chain.span.match(CHAIN_VALS_RE)
    if (!cur) {
      lines.push("  常量链结构无法解析")
      return
    }
    const actual = {
      unlimited: hasUnlimitedPatch(buf),
      yh: Number(cur[2]),
      th: Number(cur[1]),
      cap: hasBackoffCap(buf, chain),
    }
    // 出厂基线: 新鲜备份(等长补丁 size 恒不变, size 相同才可信) > 无补丁标记的当前链 > 未知
    const bak = `${bin}.retry-bak`
    let factory: { th: number; yh: number } | undefined
    let bakNote = ""
    if (existsSync(bak)) {
      if (statSync(bak).size === statSync(bin).size) {
        const bv = findRetryChain(readFileSync(bak))?.span.match(CHAIN_VALS_RE)
        if (bv) factory = { th: Number(bv[1]), yh: Number(bv[2]) }
      } else {
        bakNote = "备份与当前二进制版本不一致(跨版本旧备份), 下次需要改动时自动从当前二进制重建"
        if (!actual.unlimited && !actual.cap) factory = { th: actual.th, yh: actual.yh }
      }
    } else if (!actual.unlimited && !actual.cap) {
      factory = { th: actual.th, yh: actual.yh }
    }

    // 配置期望(四轴): restore 优先, 其次显式配置, 未配置的轴 = 出厂值
    const want = active
      ? {
          unlimited: patch.restore === true ? false : (patch.maxRetries ?? -1) === -1,
          cap: patch.restore === true ? false : patch.backoffCapMs !== undefined,
          th: patch.restore === true || patch.backoffCapMs === undefined ? factory?.th : patch.backoffCapMs,
          yh: patch.restore !== true && (patch.maxRetries ?? -1) > 0 ? patch.maxRetries : factory?.yh,
        }
      : undefined

    const cmp = (label: string, a: string, w: string | undefined) => {
      if (!active || w === undefined) lines.push(`  ${label}: ${a}`)
      else if (a === w) lines.push(`  ${label}: ${a} — 与配置一致`)
      else lines.push(`  ${label}: 实际=${a}, 配置期望=${w} — 未写入(下次启动自动改写)`)
    }
    cmp(
      "无限重试",
      actual.unlimited ? "已开启" : "未开启",
      want ? (want.unlimited ? "已开启" : "未开启") : undefined,
    )
    if (actual.unlimited) {
      // 无限模式下次数判定恒假, 次数上限是死代码, 不再单列误导
      lines.push("  次数上限: 不适用(无限重试已开启, 次数判定不参与)")
    } else {
      cmp("次数上限", `${actual.yh} 次`, want?.yh !== undefined ? `${want.yh} 次` : undefined)
    }
    cmp("退避封顶", actual.cap ? `${actual.th}ms` : `未开启(指数退避无上限, 绝对上限 ${actual.th}ms)`, want ? (want.cap ? `${want.th}ms` : "未开启") : undefined)

    const rec = state[bin]
    const st = binStat(bin)
    if (rec) {
      const hit = st && rec.size === st.size && rec.mtimeMs === st.mtimeMs
      lines.push(`  状态缓存: ${rec.want}${hit ? " (stat 命中, 下次启动跳过检查)" : " (stat 已变化, 下次启动重新检查)"}`)
    } else {
      lines.push("  状态缓存: 无记录(下次启动全量检查)")
    }
    if (bakNote) lines.push(`  备份: ${bakNote}`)
  })
  return lines.join("\n")
}

// 从 429 body 提取重置时刻(捕获组 1 = 完整时间串); 无时区后缀按 +08:00 解析。
// 返回绝对毫秒时间戳, 解析失败返回 NaN
function parseExtractedTime(m: RegExpMatchArray | null): number {
  const s = m?.[1]
  if (!s) return Number.NaN
  const base = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s.replace(" ", "T")}+08:00`
  return Date.parse(base)
}

async function quotaRetryPlugin(input: { directory?: string; client?: any }) {
  const projectDir = input.directory ?? process.cwd()
  const pluginConfig = loadConfig(projectDir)
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
  if (patch?.restore || patch?.enabled) {
    // 补丁读写量大(3×184MB), 延迟到事件循环空闲时执行, 不阻塞 opencode 启动
    setImmediate(() => {
      try {
        runPatch(patch, toast)
      } catch {}
    })
  }
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
      // /retry-setting 命令: 实际由 command.execute.before 本地处理(零模型调用);
      // 模板仅作兜底(老版本 opencode 无该 hook 时, 走工具 + 模型呈现)
      cfg.command = cfg.command ?? {}
      cfg.command["retry-setting"] = {
        description: "查看 quota-retry 重试配置与二进制补丁的实际生效状态",
        template:
          "调用 quota_retry_status 工具获取状态报告, 将其输出完整原样呈现给用户(保留所有小节与对照结论)。不要省略, 不要改写数字, 不要自行推测。",
      }
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
    // 零模型路径(同 opencode-acp /acp): 本地生成报告 → 写入 ignored 消息
    // (noReply, 进对话记录可回看, 不触发模型回复) → 抛错中断命令的模型轮次
    "command.execute.before": async (input: { command: string; sessionID?: string }, _output: unknown) => {
      if (input.command !== "retry-setting") return
      let text: string
      try {
        text = patchStatusReport(projectDir)
      } catch (e) {
        text = `[quota-retry] 状态读取失败: ${(e as Error).message}`
      }
      try {
        await toastClient?.session?.prompt?.({
          path: { id: input.sessionID },
          body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
        })
      } catch {}
      throw new Error("__QUOTA_RETRY_HANDLED__")
    },
    tool: {
      quota_retry_status: {
        description:
          "读取 quota-retry 配置(项目 .opencode/ 覆盖全局)、入口校验结果、每份 opencode 二进制重试参数的实际值(无限重试/次数上限/退避封顶), 输出配置期望与二进制实际的对照报告, 标出哪些值已写入、哪些未写入。只读, 无副作用。",
        execute: async () => patchStatusReport(projectDir),
      },
    },
  }
}

// 测试钩子挂在默认导出函数的属性上: opencode 要求模块的所有导出均为插件函数,
// 多余的具名导出(无论函数还是对象)都会导致加载失败
// (曾因 export { patchStatusReport } 报 paths[0] 类型错误, 对象导出报 not a function)
;(quotaRetryPlugin as any).__internals = { patchStatusReport, patchBinary, synthesizePristine, findRetryChain, hasUnlimitedPatch, hasBackoffCap }

export default quotaRetryPlugin
