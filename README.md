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

验证是否生效：配额耗尽时运行 opencode，opencode 会弹出 toast 提示（"xxx 配额耗尽，等待约 N 小时后自动重试"），且会话进入长时间等待而不是 2/4/8/16/32 秒连发。非配额 429 透传时也会提示（5 分钟最多一次）。

修改配置后重启 opencode 生效。

## 更新机制

opencode 对 git 安装的插件只装一次（缓存在 `~/.cache/opencode/packages/`），之后不自动拉取。本插件在每次 opencode 启动时用 `git ls-remote` 比对 GitHub 仓库最新提交（10 秒超时）：

- 有新提交 → 删除本地缓存副本（连同钉住旧版本的 lock 文件）
- 无新提交或网络不可达 → 不动

opencode 检测到缓存缺失会自动重新安装最新版（同步删除后同一进程内即自动重装），新代码在下一次启动时加载：**发布新版本后需重启 opencode 两次**（第一次完成同步删除与自动重装，第二次加载新代码）。同步成功时会有 toast 提示。

可用配置关闭或改仓库：

```jsonc
{
  "syncEnabled": false,                      // 默认 true
  "repo": "yangyaofei/opencode-quota-retry"   // 默认值
}
```

## 二进制补丁（patch-max-retries 分支）

master 分支不碰二进制。本分支额外把 opencode 硬编码的重试参数变成可配置。

### 为什么需要

opencode 把重试策略硬编码在源码里（`packages/opencode/src/session/retry.ts`），**没有任何配置项**：重试上限 `RETRY_MAX_RETRIES = 5`、退避参数、退避封顶，截至 1.18.21 均不可配（上游 issue <https://github.com/anomalyco/opencode/issues/43596> 已提、未实现）。

master 的注入方案解决了配额场景的"等多久"，但两个问题够不到：

- **次数上限**：任何可重试错误 5 次后中断。配额 429 靠注入一次长等待可绕过；但并发限流、网络错误等持续故障时，5 次 × 30s ≈ 2.5 分钟就放弃
- **退避无封顶**：响应带 headers 但没有 retry-after 时（并发限流、网络错误类），指数退避没有封顶——实测 38.4s/76.2s 一路翻倍，理论上限 24.8 天，重试间隔失控

既然上游配置不了，本分支在启动时直接等长改写 opencode 二进制里的这些常量。

### 加了什么

| 配置项 | 取值 | 作用 |
|---|---|---|
| `maxRetries` | -1（无限）或 1-99 | 重试次数上限。-1 时退避序列如 `2/4/8/16/38/76s...` 无限持续；配额场景配合 master 注入，一次重试落在限额重置后即恢复 |
| `backoffCapMs` | 10000-999999（10s-16.6min） | 无 retry-after 头时的退避封顶：指数段照常（2/4/8/16s），超上限钉住。实测 `2.1/4.6/9.7/17.6/30.0/30.0...`。`retry-after-ms` 注入路径不经过改点，配额等待不受影响 |
| `restore` | true | 从 `.retry-bak` 备份还原出厂二进制 |

组合约束（等长替换的位预算）：`backoffCapMs` ≥ 100000（6 位数）时 `maxRetries` 仅支持 -1 或 1-9。入口校验范围与组合，无效配置 toast 提示且不碰二进制。

### 如何使用

两步：

1. `opencode.jsonc` 插件指向本分支（同步机制感知 spec 里的分支，保持默认开启即可）：

```jsonc
"plugin": [
  "opencode-quota-retry@git+https://github.com/yangyaofei/opencode-quota-retry.git#patch-max-retries"
]
```

2. `quota-retry.jsonc` 加 `patch` 段：

```jsonc
{
  "providers": [ /* 同 master，配额注入配置不变 */ ],
  "patch": {
    "enabled": true,
    "maxRetries": -1,        // -1 无限 | 1-99 指定次数
    "backoffCapMs": 30000    // 可选: 指数退避封顶
  }
}
```

如需还原：`"patch": { "enabled": false, "restore": true }` 改完重启一次。

### 查询当前生效状态

opencode 里输入 `/retry-setting`（本分支），输出：

- 实际使用的配置文件路径（项目 `.opencode/quota-retry.jsonc` 优先于全局）
- providers 与 patch 配置内容、入口校验结果
- 每份 opencode 二进制重试参数的**实际值**（无限重试 / 次数上限 / 退避封顶），与配置期望逐项对照，标出哪些值已写入、哪些未写入（未写入的下次启动自动改写）
- 状态缓存是否命中（下次启动是否跳过检查）

只读查询，不改任何文件。读数由插件注册的 `quota_retry_status` 工具完成（确定性工作不过模型），命令只负责呈现。

### 如何生效

- opencode 是 bun 单二进制，内嵌 JS 明文。插件按 `=2147483647,`（绝对上限常量）锚定重试常量链 `,TH=30000,DH=2147483647,RV=5` 与上限判定点 `attempt>RV)`，做**等长替换**（字节数不变，Bun 模块偏移表不受影响）：
  - `maxRetries: -1` → 判定式改为恒假的 `attempt<-1)`
  - `maxRetries: N` → 链中数值改为 N，位数增减从相邻常量吸收
  - `backoffCapMs` → 改 TH 值 + 把无 retry-after 分支落到函数尾现成的 `Math.min(退避, TH)` 封顶式
- 改的是磁盘二进制，**下次启动生效**（正在运行的进程不受影响）；写入走临时文件 + rename（规避运行中二进制 ETXTBSY）
- 处理所有平台变体二进制（`opencode.exe`、`opencode-linux-x64`、`opencode-linux-x64-baseline` 等自动发现）
- npm 升级 opencode 覆盖二进制后，下次启动自动重打；找不到常量链（版本大改）则跳过并 toast，不做任何修改
- macOS：改字节会使代码签名失效（arm64 进程会被内核终止），写入后自动 `codesign -f -s -` 重签名，失败 toast 提示手动命令

### 启动开销与幂等

- 补丁读写量大（3×184MB），经 `setImmediate` 延迟到事件循环空闲执行，不阻塞 opencode 启动
- 状态缓存 `~/.cache/opencode/quota-retry-patch-state.json` 记每份二进制的 size + mtime + 已应用目标；启动时 `stat` 命中即跳过（不读盘、不写入、不 toast），稳态启动零开销
- 升级换文件 / 修改配置 → stat 或目标变化 → 自动重做；每个补丁点有独立的已打检测 + 写前逐点字节校验，不会重复打
- 首次写入前备份 `.retry-bak`（始终为出厂态）；状态文件损坏按空处理，重打一遍无副作用

## 限制

- master 分支（无补丁）下重试次数上限 5 次够不到；本分支可用 `patch` 修改。相关上游 issue：<https://github.com/anomalyco/opencode/issues/43596>
- 补丁基于 1.18.19 二进制布局实测；上游若合并 #43596 或重构 retry.ts，常量链匹配不到时自动停打并 toast
- 标题生成的重试不走这条路径，标题失败不影响正文
- 未配置的 provider 不受影响
