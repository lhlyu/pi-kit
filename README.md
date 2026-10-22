# @lhlyu/pi-kit

Pi Coding Agent 的模型自动发现与终端状态栏扩展。

## 功能

- **模型自动发现**：从多个 Provider 获取模型列表，通过原生 `/model` 选择和刷新。
- **终端状态栏**：显示输出速度（TPS）、首 token 耗时（TTFT）和本轮耗时（TS），支持后台子任务计时。

```text
⚡️ TPS: 50.0 tok/s 🚀 TTFT: 1.23s ⌛️ TS: 2m35s
```

## 安装

需要 Node.js ≥ 22.19.0、Pi Coding Agent ≥ 1.3.0。

```bash
pi install npm:@lhlyu/pi-kit
```

## 使用

状态栏自动启用，无需配置。两个功能可在 `/config` 中单独启停。

如需模型发现，在 `~/.pi/agent/models.json` 中添加 Provider：

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

设置 `RELAY_API_KEY` 环境变量后，重启 Pi 或执行 `/reload`，再用 `/model` 选择模型。模型列表过期时自动刷新。

更多说明：[模型发现配置](docs/model-discovery.md) · [状态栏](docs/status.md)。
