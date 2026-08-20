# opencode-quota-retry

拦截配额类 429 错误，注入精确的重试等待时间（`retry-after-ms`），让 opencode 在限额重置后再重试，而不是 5 次指数退避（约 70 秒）后放弃。

## 解决的问题

opencode 1.18.12 起把重试次数上限固定为 5 次。智谱/火山 coding plan 配额耗尽后，5 次重试只覆盖约 70 秒，会话直接中断——但错误信息里已经写明配额几小时后才重置。此前 opencode 会一直重试到限额恢复。

## 工作原理

opencode 重试时按响应头决定等待时间：`retry-after-ms` > `retry-after` > 指数退避。本插件拦截配置中 provider 的 429 响应，先用判定正则 `quotaMatch` 读响应内容判断原因：

- 配额耗尽（如智谱"已达到 5 小时的使用上限"、火山"exceeded the monthly usage quota"）→ 计算出"距限额重置还剩多久"，把结果写入 `retry-after-ms` 后交还给 opencode。opencode 按这个时间等待并显示原生重试状态条，第一次重试就落在限额重置之后
- 没匹配上（如并发限流"Requests are too frequent"）→ 不注入，原样交还 opencode 原生指数退避

重置时刻的获取顺序（`quota` 决定第一来源）：

- `quota: "zhipu"`：智谱配额查询接口（精确）→ 失败回退 `resetExtract` 从正文提取
- `quota: "body"`：只用 `resetExtract` 从 429 正文提取（火山用这个）

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
      // 判定 429 是不是配额耗尽(不匹配则透传, 走 opencode 原生重试)
      "quotaMatch": "AccountQuotaExceeded|exceeded the .*usage quota",
      // 从 429 正文提取重置时刻, 捕获组 1 = 完整时间串
      "resetExtract": "reset at\\s+((?:\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2})",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000              // 配额查询结果缓存时长(毫秒)
}
```

两组正则适配任何类似行为的 provider：`quotaMatch` 判定这个 429 是不是配额耗尽，`resetExtract` 从正文里拿下次重置时刻。两者均有内置默认值，不配也支持智谱和火山。

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | opencode 的 providerID，如 `zhipuai-coding-plan`、`volces-ark` |
| `quota` | 是 | 重置时刻来源：`zhipu`（配额查询接口，失败时回退 `resetExtract`）或 `body`（只用 `resetExtract`） |
| `quotaMatch` | 否 | 判定 429 是不是配额耗尽的正则。不匹配的 429 不注入，走 opencode 原生重试 |
| `resetExtract` | 否 | 从 429 正文提取重置时刻的正则，捕获组 1 = 完整时间串（如 `2026-08-21 23:59:59`）。无时区后缀按 +08:00 解析 |
| `quotaUrl` | 否 | 配额查询接口地址，默认智谱官方地址 |
| `apiKey` | 否 | 配额查询用的 key。不填则优先取本次请求头的 Authorization，再读 opencode 的 auth.json |
| `fallbackWaitMs` | 否 | 已确认配额耗尽但拿不到精确重置时间时的等待（默认 30000）。非配额 429 不注入，走 opencode 原生重试 |
| `bufferMs` | 否 | 附加缓冲（默认 10000）。重置时刻附近服务端可能还没生效，多等几秒避免白白消耗一次重试 |
| `quotaCacheMs` | 否 | 全局字段。配额查询结果缓存（默认 60000） |

验证是否生效：配额耗尽时运行 opencode，opencode 会弹出 toast 提示（"xxx 配额耗尽，等待约 N 小时后自动重试"），且会话进入长时间等待而不是 2/4/8/16/32 秒连发。

修改配置后重启 opencode 生效。

## 更新机制

opencode 对 git 安装的插件只装一次（缓存在 `~/.cache/opencode/packages/`），之后不自动拉取。本插件在每次 opencode 启动时自同步：比对 GitHub 仓库最新提交，有新版本则下载覆盖缓存副本。

同步发生在启动加载之后，因此新版本在下一次启动时生效：**发布新版本后需重启 opencode 两次**（第一次完成同步，第二次加载新代码）。

可用配置关闭或改仓库：

```jsonc
{
  "syncEnabled": false,                      // 默认 true
  "repo": "yangyaofei/opencode-quota-retry"   // 默认值
}
```

## 限制

- 重试次数上限（5 次）插件无法修改。并发限流持续超过 5 × fallbackWaitMs 仍会中断。相关 issue：<https://github.com/anomalyco/opencode/issues/43596>
- 标题生成的重试不走这条路径，标题失败不影响正文
- 未配置的 provider 不受影响
