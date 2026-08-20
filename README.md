# opencode-quota-retry

opencode v1 插件：拦截配额类 429 错误，注入精确的 `retry-after-ms`，让 opencode 原生重试机制
在限额重置后再重试，而不是 5 次指数退避（约 70 秒）后放弃。

## 背景

opencode v1.18.12+（commit c789868，issue #41939）把 session stream 的重试上限钉死为 5 次
（`packages/opencode/src/session/retry.ts: RETRY_MAX_RETRIES = 5`）。对"5 小时/月配额"类
provider（智谱 coding plan、火山 coding plan），配额耗尽后 5 次重试只覆盖约 70 秒，会话直接
中断——而错误信息本身说明配额几小时甚至几天后才重置。此前 opencode 会无限重试直到限额恢复。

## 原理

`retry.ts` 的 `delay()` 按优先级决定每次重试的等待时长：

```
1. error.data.responseHeaders["retry-after-ms"] 有值 → 按毫秒等待（优先）
2. error.data.responseHeaders["retry-after"] 有值 → 按秒/HTTP-date 等待
3. 都没有 → 指数退避（2s×2^n），有 headers 时无封顶，无 headers 封顶 30s
```

本插件通过 config hook 给目标 provider 注入自定义 `fetch`（`provider.options.fetch`，
经 `LLMRequestPrep` → `prepareOptions` 被 AI SDK 使用）。拦截 429 响应：

```
是 429？
├─ quota="zhipu": 调配额 API (api/monitor/usage/quota/limit) 取已耗尽限额的
│                 nextResetTime（epoch ms）→ wait = reset - now
│                 （实测: TOKENS_LIMIT.percentage=100 的 nextResetTime 与 429 message
│                   里的重置时刻分秒不差）
│                 API 失败时回退解析 429 body 时间戳
├─ quota="body":  解析 429 body 时间戳
│                 （火山: "It will reset at 2026-08-21 23:59:59 +0800 CST"）
└─ 拿不到 → 注入 fallbackWaitMs（默认 30s，并发类 429 靠它拉长重试间隔）
→ 等待时长再附加 bufferMs（默认 10s，吸收服务端时钟与重置生效的边界偏差，
  避免重试恰好卡在重置时刻白白消耗一次重试）
→ 重建 Response，注入 retry-after-ms: ceil(wait)
```

效果：主 stream 的第一次重试就落在限额重置之后 → 5 次上限碰不到；TUI 显示原生重试状态条
（retrying in Xh），用户可随时中断。

## 安装

opencode.jsonc：

```jsonc
"plugin": [
  "opencode-quota-retry@git+https://github.com/yangyaofei/opencode-quota-retry.git"
]
```

配置文件（全局 `~/.config/opencode/quota-retry.jsonc`，或项目 `.opencode/quota-retry.jsonc`，
项目优先）：

```jsonc
{
  "providers": [
    {
      "id": "zhipuai-coding-plan",   // opencode 的 providerID
      "quota": "zhipu",              // zhipu=调配额 API 精确重置时间; body=解析 429 body
      "quotaUrl": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      // "apiKey": "",               // 可选, 不填则读 ~/.local/share/opencode/auth.json
      "fallbackWaitMs": 30000,       // 拿不到重置时间时的回退等待(并发类 429), ms
      "bufferMs": 10000              // 附加缓冲(服务端时钟/重置生效偏差), ms, 默认 10000
    },
    {
      "id": "volces-ark",
      "quota": "body",
      "fallbackWaitMs": 30000
    }
  ],
  "quotaCacheMs": 60000              // 配额 API 结果缓存, ms
}
```

改动配置后需重启 opencode（插件在启动时读取一次）。

## 边界

- **5 次重试上限本身插件无法移除**（插件够不到 Effect 调度层）。并发 429 持续超过
  `5 × fallbackWaitMs` 仍会断。上限可配置化见上游 issue:
  https://github.com/anomalyco/opencode/issues/43596
- 标题生成走 SDK 层 retries:2（不读 retry-after-ms），失败无害
- 非 429 响应原样透传；未配置的 provider 不受影响

## 实测验证（2026-08-20，opencode 1.18.18）

- **火山**（月配额耗尽）：`[quota-retry] volces-ark: 429 intercepted, injecting retry-after-ms=111007764`
  （30.8 小时），主 stream 一次错误后静默等待至重置时刻；对照组（无插件）2/4/8/16/32s 连发
  5 次后 72s 中断
- **智谱**（5 小时窗口耗尽）：注入 `retry-after-ms=8571808`（2.38 小时），与配额 API 的
  `TOKENS_LIMIT.nextResetTime=2026-08-20 19:42:37` 及 429 message 完全一致
- 配额 API 缓存生效：同一窗口内 4 次注入值完全相同
