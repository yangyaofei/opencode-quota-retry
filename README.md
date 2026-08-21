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

## 二进制补丁（本分支新增：改重试次数上限）

`patch-max-retries` 分支提供。每次 opencode 启动时自动检测并修改 opencode 二进制里硬编码的重试上限（`RETRY_MAX_RETRIES = 5`）：

```jsonc
{
  "patch": {
    "enabled": true,
    "maxRetries": -1,        // -1 = 无限重试; 或 1-999 指定次数
    "backoffCapMs": 30000    // 可选: 指数退避封顶 (10000-999999, 即 10s-16.6min)
  }
}
```

`backoffCapMs` 针对无 `retry-after` 头的重试（并发限流、网络错误类）：指数段照常（2/4/8/16s），超过上限后钉住。实测序列 `2.1/4.6/9.7/17.6/30.0/30.0/30.0...`（未打补丁时该分支无封顶，实测 38.4s/76.2s 一路翻倍到 24.8 天）。`retry-after-ms` 注入路径不经过此改点，配额等待值不受影响。

约束：等长替换的位预算有限——`backoffCapMs`（6 位数，即 ≥100s）与 `maxRetries`（2 位数，即 ≥10）不能同时设置；`maxRetries` 有效范围 -1 或 1-99；插件在启动入口做范围与组合校验，无效配置 toast 提示且不动二进制。

启动开销与幂等：

- 补丁读写量大（3×184MB），通过 `setImmediate` 延迟到事件循环空闲执行，不阻塞 opencode 启动
- 状态缓存 `~/.cache/opencode/quota-retry-patch-state.json` 记录每份二进制的 size + mtime + 已应用目标；启动时 `stat` 命中即跳过（不读盘、不写入、不 toast）
- npm 升级换文件 / 修改配置 → stat 或目标变化 → 自动失效重做；npm 卸载平台包 → 状态条目自动清理
- 状态文件损坏按空处理（下次启动重打一遍，幂等无副作用）

启用方式（分支安装，`opencode.jsonc`）：

```jsonc
"opencode-quota-retry@git+https://github.com/yangyaofei/opencode-quota-retry.git#patch-max-retries"
```

同步机制感知安装 spec 里的分支：分支推了新 commit 会自动跟进（删除重装），无需关闭 `syncEnabled`；master 安装（无 `#`）行为不变。

已实测（opencode 1.18.19，三份二进制）：`-1` + `backoffCapMs: 30000` 组合下退避序列 `2.1/4.6/9.7/17.6/30.0/30.0...` 且无限重试；`9` 与 `99` 模式正确改写常量链（`yh=9` / `dh=999999999,yh=99`，退避封顶值 30s 全程保全）；`restore` 完整还原；分支安装连续启动无误删。

- `-1`：把上限判定 `attempt > 5` 等长改写为恒假的 `attempt < -1`，无限重试
- `1-999`：改常量链里的数值；位数增减从相邻的无 headers 封顶值（30000）伸缩补偿，文件总长度不变
- 还原：`{"patch": {"enabled": false, "restore": true}}` 从 `.retry-bak` 备份恢复

机制说明：

- opencode 是 bun 单二进制，内嵌 JS 明文；插件按 `=2147483647,`（max delay 常量）锚定重试常量链 `,TH=30000,DH=2147483647,RV=5`，等长替换
- 正在运行的二进制直接写会报 ETXTBSY，走临时文件 + rename 覆盖；改动在下次启动生效
- 同时处理所有平台变体二进制（`opencode-linux-x64`、`opencode-linux-x64-baseline` 等）
- 找不到常量链（opencode 版本大改）时跳过并 toast 提示，不做任何修改
- 注意：npm 升级 opencode 后二进制被覆盖，下次启动插件会自动重打
- macOS：修改字节会使代码签名失效（arm64 上进程会被内核直接终止），插件写入后自动执行 `codesign -f -s -` 重新 ad-hoc 签名；签名失败会 toast 提示手动命令
- 本分支若经 git URL 安装，请同时设 `"syncEnabled": false`（自同步按 master 比对，会删掉分支版本）

## 限制

- master 分支（无补丁）下重试次数上限 5 次够不到；本分支可用 `patch` 修改。相关上游 issue：<https://github.com/anomalyco/opencode/issues/43596>
- 标题生成的重试不走这条路径，标题失败不影响正文
- 未配置的 provider 不受影响
