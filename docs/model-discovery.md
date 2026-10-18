# 模型发现配置

模型发现由 pi-kit 扩展实现。Pi 提供异步扩展加载、`pi.registerProvider()`、模型选择和认证机制；这里的网络发现、持久化缓存与失败回退不是 Pi 内置功能。

## 配置

使用 Pi 用户目录中的 `models.json`（默认 `~/.pi/agent/models.json`，跟随 `PI_CODING_AGENT_DIR`）。扩展支持与 Pi 一致的 JSON 注释，不会改写配置文件。

```json
{
    "providers": {
        "relay-a": {
            "baseUrl": "https://relay-a.example.com/v1",
            "apiKey": "$RELAY_A_API_KEY",
            "api": "openai-completions",
            "discoverModels": true
        },
        "relay-b": {
            "baseUrl": "https://relay-b.example.com",
            "modelsUrl": "https://catalog.example.com/v1/models",
            "apiKey": "${RELAY_B_API_KEY}",
            "api": "anthropic-messages",
            "discoverModels": true
        }
    }
}
```

- 只处理 `discoverModels: true` 的 Provider；原有静态 Provider 不受影响。
- Provider 必须使用独立名称，不能使用 `openai`、`anthropic` 等内置名称，也不要与其他扩展的 Provider 重名。
- 支持 `openai-completions`、`openai-responses`、`anthropic-messages`，协议必须符合第三方实际行为。
- `modelsUrl` 是可选的完整发现 URL，直接请求，不追加路径。不设置时，去掉 `baseUrl` 尾部斜线后追加 `/models`。如果 `baseUrl` 带查询参数，必须显式指定 `modelsUrl`，避免错误拼接或把聊天端点的查询凭证发送到其他路径。
- `modelsUrl` 不影响聊天端点。发现请求会发送本 Provider 的鉴权信息，只能填写可信地址；禁止自动跟随重定向，防止凭证被转发。
- 发现通过官方 `ModelRuntime.getAuth()` 解析认证，与原生聊天一样优先使用 `/login` 保存的本 Provider 凭证，支持仅登录而不配置 `apiKey`，也支持凭证中的 Provider 级环境变量。不会复用其他 Provider 的登录凭证。
- `apiKey` 和 `headers` 的环境变量插值、字面量及转义均由 Pi 解析。为避免在启动阶段执行不可取消的同步命令，`models.json` 中包含 `!command` 的发现配置会警告并尝试缓存回退；`auth.json` 中的凭证解析仍遵循宿主行为。
- OpenAI 协议默认使用 Bearer 鉴权；Anthropic 协议使用 `x-api-key` 和 `anthropic-version`。`authHeader: true` 按原生语义追加 Bearer，不移除 Anthropic 的 `x-api-key`。显式 `headers` 及最终鉴权头遵循 Pi 的解析结果。
- 无鉴权的本地服务可按 Pi 原生惯例配置一个占位 `apiKey`。
- 不要同时配置 `models` 或 `oauth`；动态列表以发现结果为准，不合并手写列表，也不接管订阅登录。

发现接口应返回 OpenAI/Anthropic 风格的完整列表：

```json
{
    "data": [{ "id": "claude-sonnet-4-5" }, { "id": "custom-chat-model" }]
}
```

面向聊天模型发现，不自动探测协议。会排除内置目录明确标记的图片或分类模型、已知 OpenAI 非聊天产品，以及响应明确标注为 embedding、rerank、图片、音频等非聊天类型的模型；未知且没有明确类型的 ID 仍保守保留，不做宽泛的名称猜测。原始列表为空或过滤后没有聊天模型时都回退缓存。

分页字段会严格校验类型。明确存在未完成分页的响应会被拒绝，不会以部分结果删除模型；当前不自动追踪分页，发现地址应返回完整列表。

## 刷新与选择

- 启动时在异步 Extension Factory 内完成发现与注册，随后 Pi 才继续启动模型选择。模型可用于 `/model` 和 `pi --list-models`，可选性仍由原生认证检查决定。
- 使用原生 `/reload` 手动刷新，不增加独立命令，不覆盖内置命令。
- 不定时轮询，不在打开 `/model` 时联网发现，也不在每次发送消息时刷新。
- 每个 Provider 的网络请求独立设置 5 秒超时，覆盖响应头和响应体；多个 Provider 并发执行，失败彼此隔离。
- 不主动切换当前模型，不中断生成。刷新由 Pi 的标准 reload 生命周期处理，不在后台改动正在使用的模型目录。
- 失败警告写入 stderr，不将密钥、完整地址或响应正文写入日志，不污染 JSON/RPC 的 stdout。

## 元数据与兼容性

按完整模型 ID 匹配 Pi 内置聊天目录，复用名称、上下文窗口、输出上限、推理能力、输入类型及价格。多个候选时优先原生厂商，再按协议和 Provider 名稳定选择，不做模糊名称匹配。

不继承原厂端点、认证头、兼容参数和缓存保温配置。实际 API 使用当前 Provider 的 `api`，Provider 级 `compat` 显式应用到发现模型上。逐模型修正沿用 Pi 的 `modelOverrides`：

```json
{
    "providers": {
        "relay-a": {
            "baseUrl": "https://relay-a.example.com/v1",
            "apiKey": "$RELAY_A_API_KEY",
            "api": "openai-completions",
            "discoverModels": true,
            "compat": {
                "supportsStore": false
            },
            "modelOverrides": {
                "custom-chat-model": {
                    "contextWindow": 65536,
                    "maxTokens": 8192,
                    "reasoning": false
                }
            }
        }
    }
}
```

未匹配模型使用 32,768 上下文、4,096 输出上限、仅文本输入、无推理和零价格。零价格表示未知，不代表免费；匹配模型的目录价格也不是第三方实际收费。第三方的能力可能低于原厂，需根据已验证行为设置兼容参数和覆盖值，不能仅凭模型 ID 保证完整兼容。

## 缓存与回退

缓存在 Pi 用户目录的 `pi-kit/cache/providers/`，每个 Provider 独立文件，使用配置摘要隔离不同端点。只保存成功发现的 ID、时间及摘要，不保存密钥或原始响应。加载时重新匹配当前内置目录，并应用当前兼容配置与原生覆盖值。

只有收到 HTTP 200 并成功获取完整、有效、非空聊天列表后才替换缓存，成功结果中的模型删除才会生效。HTTP 206 等非完整响应、错误信息信封、网络失败、超时、无效 JSON/UTF-8、坏模型 ID、分页不完整、异常空列表、响应过大时均保留旧缓存。无有效缓存则跳过该 Provider，不影响其他 Provider。模型 ID 上限为 512 个 UTF-16 代码单元，单次最多 10,000 个模型，响应及缓存文件上限为 2 MiB。

配置解析使用 `jsonc-parser`，结构校验使用 `typebox`；任何 JSONC 语法错误都会拒绝加载，不接受容错恢复的部分配置，也不启用 Pi 不支持的 JSON5 扩展语法。缓存原子写入及临时文件清理由 `write-file-atomic` 负责；缓存写入失败不会影响本次有效列表注册。更改端点、协议或鉴权配置后不复用原配置缓存。缓存不设过期清空策略，也不会改动 `models.json`、`auth.json` 或已有 `/login` 凭证。若与其他模型发现扩展同时使用，请只让一个扩展负责同一 Provider。
