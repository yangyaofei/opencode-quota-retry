# opencode-quota-retry

拦截配额类 429 错误，注入精确的重试等待时间（`retry-after-ms`），让 opencode 在限额重置后再重试，而不是 5 次指数退避（约 70 秒）后放弃。

## 解决的问题

opencode 1.18.12 起把重试次数上限固定为 5 次。智谱/火山 coding plan 配额耗尽后，5 次重试只覆盖约 70 秒，会话直接中断——但错误信息里已经写明配额几小时后才重置。此前 opencode 会一直重试到限额恢复。

## 工作原理

opencode 重试时按响应头决定等待时间：`retry-after-ms` > `retry-after` > 指数退避。本插件拦截配置中 provider 的 429 响应，计算出"距限额重置还剩多久"，把结果写入 `retry-after-ms` 后交还给 opencode。opencode 按这个时间等待并显示原生重试状态条，第一次重试就落在限额重置之后。

重置时间来源有两种：

- `quota: "zhipu"`：智谱配额查询接口，返回精确的重置时间戳
- `quota: "body"`：从 429 响应正文提取时间戳（火山用这个）

## 安装

`opencode.jsonc`：

```jsonc
"plugin": [
  "opencode-quota-retry@git+https://github.com/yangyaofei/opencode-quota-retry.git"
]
```

## 配置

配置文件放在全局 `~/.config/opencode/quota-retry.jsonc` 或项目的 `.opencode/quota-retry.jsonc`（项目优先）。一个 provider 一条配置：

```jsonc
{
  "providers": [
    {
      "id": "zhipuai-coding-plan",   // opencode 里的 providerID
      "quota": "zhipu",              // 重置时间来源: zhipu 或 body
      "fallbackWaitMs": 30000,       // 拿不到重置时间时每次重试等多久(毫秒)
      "bufferMs": 10000              // 在计算出的等待上额外加的缓冲(毫秒)
    },
    {
      "id": "volces-ark",
      "quota": "body",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000              // 配额查询结果缓存时长(毫秒)
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | opencode 的 providerID，如 `zhipuai-coding-plan`、`volces-ark` |
| `quota` | 是 | 重置时间来源：`zhipu`（配额查询接口，精确）或 `body`（解析 429 正文） |
| `quotaUrl` | 否 | 配额查询接口地址，默认智谱官方地址 |
| `apiKey` | 否 | 配额查询用的 key；不填则读 opencode 的 auth.json |
| `fallbackWaitMs` | 否 | 拿不到重置时间时的等待（默认 30000）。并发限流（非配额耗尽）的 429 会走这里 |
| `bufferMs` | 否 | 附加缓冲（默认 10000）。重置时刻附近服务端可能还没生效，多等几秒避免白白消耗一次重试 |
| `quotaCacheMs` | 否 | 全局字段。配额查询结果缓存（默认 60000） |

验证是否生效：配额耗尽时运行 opencode，日志出现 `[quota-retry] xxx: 429 intercepted, injecting retry-after-ms=...`，且会话进入长时间等待而不是 2/4/8/16/32 秒连发。

修改配置后重启 opencode 生效。

## 限制

- 重试次数上限（5 次）插件无法修改。并发限流持续超过 5 × fallbackWaitMs 仍会中断。相关 issue：<https://github.com/anomalyco/opencode/issues/43596>
- 标题生成的重试不走这条路径，标题失败不影响正文
- 未配置的 provider 不受影响
