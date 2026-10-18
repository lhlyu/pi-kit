# 发布

修改 `package.json` 的 `version` 为新正式版本并推送到 `main`，工作流会自动校验、发布 npm 包并创建 Release。同一提交重跑不会重复上传。

## 首次配置

1. 本地执行 `npm login && npm publish` 创建 npm 包。
2. 在 npmjs.com 包设置中，为当前仓库的 `.github/workflows/publish.yml` 配置 Trusted Publisher。
3. 在 2 天内完成首次 OIDC 发布，否则需重建配置。

工作流需使用 GitHub 托管 runner、npm ≥ 11.5.1 和 `id-token: write`，无需保存 npm token。`repository.url` 须与仓库一致；公开仓库自动生成 provenance。
