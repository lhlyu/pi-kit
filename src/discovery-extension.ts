import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { discoverProviders } from './model-discovery.ts'

const MAX_REPORTED_WARNINGS = 5

/**
 * 模型发现独立成一个扩展入口，便于用 `/config` 单独启停。
 * 工厂阶段没有 UI 上下文，先收集警告，等 session_start 再用通知或 stderr 展示。
 */
export default async function discoveryExtension(
    pi: ExtensionAPI,
): Promise<void> {
    const warnings: string[] = []
    let context: ExtensionContext | undefined
    await discoverProviders(pi, {
        agentDir: getAgentDir(),
        warn: (message) => {
            if (!context) warnings.push(message)
            else if (context.hasUI)
                context.ui.notify(`pi-kit：${message}`, 'warning')
            else {
                try {
                    process.stderr.write(`[pi-kit] ${message}\n`)
                } catch {
                    // 诊断输出失败不能影响刷新。
                }
            }
        },
        getAuth: async (name) =>
            (await context?.modelRegistry.getProviderAuth(name))?.auth,
    })
    let delivered = warnings.length === 0
    const writeStderr = () => {
        if (delivered) return
        delivered = true
        process.removeListener('exit', writeStderr)
        try {
            for (const message of warnings)
                process.stderr.write(`[pi-kit] ${message}\n`)
        } catch {
            // stderr 可能已关闭，退出阶段不能再抛异常。
        }
    }
    // 没有 session_start 的命令（例如 pi --list-models）在退出前补一次 stderr。
    // 用 exit 而不是 beforeExit：Pi 的一次性命令会直接 process.exit()。
    if (!delivered) process.once('exit', writeStderr)

    pi.on('session_start', (_event, ctx) => {
        context = ctx
        if (delivered) return
        process.removeListener('exit', writeStderr)
        if (!ctx.hasUI) {
            writeStderr()
            return
        }
        delivered = true
        const shown = warnings.slice(0, MAX_REPORTED_WARNINGS)
        for (const message of shown)
            ctx.ui.notify(`pi-kit：${message}`, 'warning')
        const remaining = warnings.length - shown.length
        if (remaining > 0)
            ctx.ui.notify(`pi-kit：另有 ${remaining} 条模型发现警告`, 'warning')
    })

    pi.on('session_shutdown', () => {
        context = undefined
        delivered = true
        process.removeListener('exit', writeStderr)
    })
}
