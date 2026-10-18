# @lhlyu/pi-kit

个人专属的 Pi Coding Agent 工具箱，提供终端状态统计与多 Provider 模型自动发现。

## 安装

需要 Node.js ≥ 22.19.0 和 Pi Coding Agent ≥ 1.3.0。

```bash
pi install npm:@lhlyu/pi-kit
```

### 启用模型发现

在 Pi 用户目录的 `models.json` 中添加独立 Provider：

```json
{
    "providers": {
        "my-relay": {
            "baseUrl": "https://relay.example.com/v1",
            "modelsUrl": "https://relay.example.com/v1/models",
            "apiKey": "$RELAY_API_KEY",
            "api": "openai-completions",
            "discoverModels": true
        }
    }
}
```

设置对应环境变量，启动或执行 `/reload` 后，通过 `/model` 选择模型。`modelsUrl` 可省略，默认请求 `baseUrl` 下的 `/models`。更多说明见[模型发现配置](docs/model-discovery.md)。

## 特征

- **模型自动发现**：支持多个独立 Provider，无需维护模型列表；启动和 `/reload` 时刷新，失败时保留上次成功缓存，打开 `/model` 不联网发现。
- **生成速度（TPS）**：实时展示输出速度，结束后显示本轮平均速度；实时数值为估算值。
- **本轮耗时（TS）**：展示整轮任务耗时，包含模型等待与工具执行时间。
- **自动更新**：任务开始时重置统计，执行期间持续更新，结束后保留结果。
- **终端状态栏**：仅在交互式终端中显示，不影响其他运行模式。

```text
⚡ TPS: 50.0 tok/s ⏳ TS: 2m35s
```
