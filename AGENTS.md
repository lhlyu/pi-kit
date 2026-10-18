# 开发规则

- 使用 TypeScript + ESM，类型导入使用 `import type`，本地导入带 `.ts` 扩展名。
- 默认 4 个空格缩进、不加分号、使用单引号；JSON / YAML / YML 使用 2 个空格。格式以 Prettier 配置为准。
- 按需求实现，保持简单，不做无关重构，不引入不必要的依赖。
- Pi 扩展入口为 `src/index.ts`，使用当前版本的官方 API；宿主提供的包声明为 `peerDependencies`。
- 不在扩展工厂中启动长期任务，资源在 `session_shutdown` 中清理；注意不同运行模式，不随意向 stdout 输出日志。
- 使用 npm 管理依赖，同步维护 `package-lock.json`。
- 新增或修改功能时补充测试，使用 Node.js 内置测试运行器；使用方式变化时更新 README。
- 完成修改后运行 `npm run check`，需要格式化时运行 `npm run format`。
