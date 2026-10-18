import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { renderStatus, RoundStats } from './status.ts'

const STATUS_KEY = 'pi-kit:stats'
// 按需合并到约 30 FPS，不启动持续的高频刷新循环。
const RENDER_INTERVAL_MS = 33

export default function piKit(pi: ExtensionAPI): void {
    let stats = new RoundStats()
    let timer: ReturnType<typeof setInterval> | undefined
    let pendingRender: ReturnType<typeof setTimeout> | undefined
    let lastRender = -Infinity
    let isShutdown = false

    const cancelPendingRender = () => {
        const current = pendingRender
        pendingRender = undefined
        try {
            if (current !== undefined) clearTimeout(current)
        } catch {
            // 即使清理失败，回调也会通过身份校验失效。
        }
    }

    const stopTimer = () => {
        cancelPendingRender()
        const current = timer
        timer = undefined
        try {
            if (current !== undefined) clearInterval(current)
        } catch {
            // 清理本身也可能失败，不能让异常逃出安全边界。
        }
    }

    // 仅包裹同步回调；统计或 UI 故障不能影响宿主，也不能在定时器里外抛。
    const safely = <Args extends unknown[]>(
        handler: (...args: Args) => void,
    ) => {
        return (...args: Args) => {
            try {
                handler(...args)
            } catch {
                stopTimer()
            }
        }
    }

    const isActive = (ctx: ExtensionContext) =>
        ctx.mode === 'tui' && !isShutdown && stats.isRunning

    const render = (ctx: ExtensionContext, force = false) => {
        if (ctx.mode !== 'tui' || isShutdown) return
        const now = performance.now()
        const remaining = RENDER_INTERVAL_MS - (now - lastRender)
        if (!force && remaining > 0) {
            if (pendingRender !== undefined) return
            const current = setTimeout(
                safely(() => {
                    if (pendingRender !== current) return
                    pendingRender = undefined
                    if (isActive(ctx)) render(ctx)
                }),
                Math.ceil(remaining),
            )
            pendingRender = current
            current.unref()
            return
        }
        cancelPendingRender()
        ctx.ui.setStatus(
            STATUS_KEY,
            renderStatus(stats.snapshot(now), ctx.ui.theme),
        )
        lastRender = now
    }

    pi.on(
        'session_start',
        safely((_event, ctx) => {
            stopTimer()
            isShutdown = false
            stats = new RoundStats()
            render(ctx, true)
        }),
    )

    pi.on(
        'agent_start',
        safely((_event, ctx) => {
            if (ctx.mode !== 'tui' || isShutdown) return
            // 自动重试仍属于同一轮，保留统计和已有计时器。
            if (!stats.isRunning) stats.start(performance.now())
            render(ctx, true)
            if (timer !== undefined) return

            // 等待首字或执行工具时，耗时也继续更新。
            const current = setInterval(
                safely(() => {
                    if (timer === current && isActive(ctx)) render(ctx)
                }),
                1_000,
            )
            timer = current
            current.unref()
        }),
    )

    pi.on(
        'turn_start',
        safely((_event, ctx) => {
            // 无流式内容时，message_start 可能直到请求完成才派发。
            if (!isActive(ctx)) return
            stats.prepareMessage(performance.now())
            render(ctx, true)
        }),
    )

    pi.on(
        'message_update',
        safely((payload, ctx) => {
            if (!isActive(ctx)) return
            const event = payload?.assistantMessageEvent

            switch (event?.type) {
                case 'text_delta':
                case 'thinking_delta':
                case 'toolcall_delta':
                    if (
                        typeof event.delta !== 'string' ||
                        event.delta.length === 0
                    )
                        return
                    stats.recordDelta(performance.now())
                    render(ctx)
                    break
            }
        }),
    )

    pi.on(
        'message_end',
        safely((event, ctx) => {
            const message = event?.message
            if (!isActive(ctx) || message?.role !== 'assistant') return
            // 按消息校准，避免多次工具调用后的累计 usage 被重复计算。
            stats.endMessage(message.usage?.output, performance.now())
            render(ctx, true)
        }),
    )

    // agent_end 后可能还有重试或自动续轮，真正停止时才冻结统计。
    pi.on(
        'agent_settled',
        safely((_event, ctx) => {
            stopTimer()
            if (!isActive(ctx)) return
            stats.finish(performance.now())
            render(ctx, true)
        }),
    )

    pi.on(
        'session_shutdown',
        safely((_event, ctx) => {
            isShutdown = true
            stopTimer()
            if (ctx.mode === 'tui') ctx.ui.setStatus(STATUS_KEY, undefined)
        }),
    )
}
