# 模型发现

在 `~/.pi/agent/models.json` 中配置 Provider，最小示例见 [README](../README.md#使用)。设置了 `PI_CODING_AGENT_DIR` 时使用对应目录。

## 配置

- **名称**：使用独立名称，避免与内置 Provider 或其他扩展冲突。
- **协议**：`api` 支持 `openai-completions`、`openai-responses`、`anthropic-messages`。
- **地址**：默认请求 `baseUrl/models`；可用 `modelsUrl` 指定完整地址，`baseUrl` 带查询参数时必须指定。
- **鉴权**：优先使用 `/login` 保存的凭证，否则使用 `apiKey`；支持环境变量和自定义 `headers`，不支持 `!command`。无鉴权的本地服务可填占位密钥。
- **缓存**：默认有效期 5 分钟，可用 `cacheTtlMinutes` 调整；设为 `0` 表示每次刷新都联网。

不要同时配置 `models` 或 `oauth`。发现请求会携带凭证，请使用可信地址并优先选择 HTTPS。

接口需返回 OpenAI 风格的列表，例如 `{"data":[{"id":"my-chat-model"}]}`；支持同源分页，明确的非聊天模型会被过滤。

`discoverModels`、`modelsUrl`、`cacheTtlMinutes` 是扩展字段，编辑器的官方 schema 可能提示未知字段，不影响加载。

## 模型能力

已知模型复用 Pi 内置能力与价格，支持常见厂商前缀和版本后缀匹配。中转服务的实际计费可能不同。

未知模型默认仅支持文本、不启用推理，上下文 32,768、输出上限 4,096；价格为零表示未知，并非免费。可用 `modelOverrides` 覆盖能力和价格，用 `compat` 调整协议兼容参数。

## 刷新与故障

- 启动、`/reload` 或打开 `/model` 时，缓存过期才联网刷新。
- 修改配置后执行 `/reload`；更新 `/login` 凭证后直接打开 `/model` 重试。
- 请求超时为 5 秒；失败或列表无效时保留上次成功目录。
- `--offline` 或 `PI_OFFLINE=1` 只读缓存，无缓存则不提供模型。
- 缓存位于 Pi 用户目录的 `pi-kit/cache/providers/`，不保存密钥；启动诊断可设置 `PI_KIT_DEBUG=1`。
