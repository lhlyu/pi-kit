# 模型发现配置

## 配置

编辑 `~/.pi/agent/models.json`（设置了 `PI_CODING_AGENT_DIR` 时使用对应目录）：

```json
{
    "providers": {
        "my-relay": {
            "baseUrl": "https://relay.example.com/v1",
            "apiKey": "$RELAY_API_KEY",
            "api": "openai-completions",
            "discoverModels": true
        }
    }
}
```

设置环境变量后，重启 Pi 或执行 `/reload`，通过 `/model` 选择模型。可添加多个 Provider。

## 配置要点

- **名称**：使用独立名称，不要用 `openai`、`anthropic` 等内置名称，也不要与其他扩展重名。
- **协议**：`api` 支持 `openai-completions`、`openai-responses`、`anthropic-messages`，按服务实际协议选择。
- **发现地址**：默认请求 `baseUrl/models`；可用 `modelsUrl` 指定完整地址。`baseUrl` 带查询参数时必须指定它。
- **鉴权**：优先使用 `/login` 保存的本 Provider 凭证，否则使用 `apiKey`；支持环境变量和自定义 `headers`，发现配置不支持 `!command`。无鉴权的本地服务可填占位 `apiKey`。
- **安全**：发现请求会携带鉴权信息，`modelsUrl` 只能填写可信地址。
- **限制**：不要同时配置 `models` 或 `oauth`，同一 Provider 只交给一个扩展管理。

发现接口须返回完整、非空的模型列表，不支持自动翻页：

```json
{
    "data": [{ "id": "claude-sonnet-4-5" }, { "id": "custom-chat-model" }]
}
```

## 模型能力

已知模型沿用 Pi 内置能力信息，明确的非聊天模型会被过滤。未知模型默认上下文 32,768、输出上限 4,096，仅支持文本，不启用推理；价格显示为零表示未知，并非免费。

第三方服务能力可能不同，可在 Provider 中用 `compat` 调整兼容参数、用 `modelOverrides` 按模型 ID 覆盖 `contextWindow`、`maxTokens`、`reasoning` 等字段。

## 刷新与故障

- 启动或 `/reload` 时刷新；打开 `/model` 不会联网发现。
- 请求超时为 5 秒；失败、列表为空或不完整时保留旧缓存，无缓存则跳过该 Provider。
- 缓存位于 Pi 用户目录的 `pi-kit/cache/providers/`，不保存密钥；修改端点、协议或鉴权后，旧缓存不再复用。
