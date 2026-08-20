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
// 闭包边界(不改什么):
//   - 不碰重试次数上限(插件够不到 Effect 调度层), 上游 issue:
//     https://github.com/anomalyco/opencode/issues/43596
//   - 并发类 429(配额 API 显示健康)只能注入 fallbackWaitMs 拉长间隔, 超窗仍会断
//   - 标题生成走 SDK 层 retries:2, 不读 retry-after-ms, 失败无害
//   - 非 429 响应原样透传

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

type ProviderConfig = {
  id: string
  quota: "zhipu" | "body"
  quotaUrl?: string
  fallbackWaitMs?: number
  apiKey?: string
}

type PluginConfig = {
  providers: ProviderConfig[]
  quotaCacheMs?: number
}

const DEFAULT_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
const DEFAULT_FALLBACK_WAIT_MS = 30_000
const DEFAULT_QUOTA_CACHE_MS = 60_000

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

function parseBodyResetMs(text: string): number {
  const m = text.match(/(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/)
  if (!m) return Number.NaN
  return Date.parse(`${m[1]}T${m[2]}+08:00`) - Date.now()
}

export default async function (input: { directory?: string }) {
  const pluginConfig = loadConfig(input.directory ?? process.cwd())
  const quotaCacheMs = pluginConfig.quotaCacheMs ?? DEFAULT_QUOTA_CACHE_MS
  const cache = new Map<string, { at: number; wait: number }>()

  async function getZhipuResetMs(p: ProviderConfig, apiKey: string): Promise<number> {
    const hit = cache.get(p.id)
    if (hit && Date.now() - hit.at < quotaCacheMs) return hit.wait
    const quotaUrl = p.quotaUrl ?? DEFAULT_QUOTA_URL
    const wait = await (async () => {
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
        if (!Number.isFinite(reset)) return Number.NaN
        return reset - Date.now()
      } catch {
        return Number.NaN
      }
    })()
    cache.set(p.id, { at: Date.now(), wait })
    return wait
  }

  function makeFetch(p: ProviderConfig) {
    const apiKey = p.apiKey ?? readApiKey(p.id)
    const fallbackWaitMs = p.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS
    return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await fetch(url, init)
      if (res.status !== 429) return res
      const text = await res.text()
      let waitMs = Number.NaN
      if (p.quota === "zhipu") {
        if (apiKey) waitMs = await getZhipuResetMs(p, apiKey)
        if (Number.isNaN(waitMs)) waitMs = parseBodyResetMs(text)
      } else {
        waitMs = parseBodyResetMs(text)
      }
      if (!Number.isFinite(waitMs) || waitMs <= 0) waitMs = fallbackWaitMs
      console.log(`[quota-retry] ${p.id}: 429 intercepted, injecting retry-after-ms=${Math.ceil(waitMs)}`)
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: { ...Object.fromEntries(res.headers), "retry-after-ms": String(Math.ceil(waitMs)) },
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
