# 发布

执行 `npm version <版本号> --no-git-tag-version` 同步更新版本与锁文件，提交并推送到 `main` 后自动发布 npm 包和 GitHub Release。同一提交重跑不会重复上传。

## 首次配置

1. 本地执行 `npm login && npm publish` 创建 npm 包。
2. 在 npmjs.com 包设置中，为当前仓库的 `.github/workflows/publish.yml` 配置 Trusted Publisher。
3. 在 2 天内完成首次 OIDC 发布，否则需重建配置。

工作流需使用 GitHub 托管 runner、npm ≥ 11.5.1 和 `id-token: write`，无需保存 npm token。`repository.url` 须与仓库一致；公开仓库自动生成 provenance。
