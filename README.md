# @lhlyu/pi-kit

个人专属的 Pi Coding Agent 工具箱。

## 功能

- **模型自动发现**：支持多个 Provider，无需手动维护模型列表。
- **终端状态栏**：展示输出速度（TPS）、首 token 耗时（TTFT）和本轮耗时（TS）。

```text
⚡ TPS: 50.0 tok/s 🚀 TTFT: 1.23s ⏳ TS: 2m35s
```

## 安装

需要 Node.js ≥ 22.19.0、Pi Coding Agent ≥ 1.3.0。

```bash
pi install npm:@lhlyu/pi-kit
```

## 使用

状态栏在交互式终端中自动启用，无需配置。

如需模型自动发现，在 Pi 用户目录的 `models.json` 中添加 Provider：

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

设置 `RELAY_API_KEY` 环境变量，重启 Pi 或执行 `/reload`，再通过 `/model` 选择模型。

更多配置见 [模型发现配置](docs/model-discovery.md)。
