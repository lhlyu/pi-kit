import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { renderStatus, RoundStats } from './status.ts'

const STATUS_KEY = 'pi-kit:stats'
// 按需合并到约 30 FPS，不启动持续的高频刷新循环。
const RENDER_INTERVAL_MS = 33
// 异步子任务完成会唤醒一次父任务；若没有唤醒（例如父任务已被停止），
// 留一小段时间后按收到完成事件的时刻冻结总耗时。
const WAKE_GRACE_MS = 5_000
const BACKGROUND_STARTED_EVENT = 'subagent:async-started'
const BACKGROUND_COMPLETE_EVENT = 'subagent:async-complete'

export default function piKit(pi: ExtensionAPI): void {
    let stats = new RoundStats()
    let timer: ReturnType<typeof setInterval> | undefined
    let pendingRender: ReturnType<typeof setTimeout> | undefined
    let wakeTimer: ReturnType<typeof setTimeout> | undefined
    let pendingFinishAt: number | undefined
    let lastRender = -Infinity
    let isShutdown = false
    let agentActive = false
    // pi-subagents 用会话文件路径（存在时）标识会话，状态栏同时记录 ID 和路径。
    let sessionIdentities = new Set<string>()
    let lastCtx: ExtensionContext | undefined
    // 同一进程里可能同时运行多个会话；只统计当前会话启动的后台任务。
    const backgroundRuns = new Set<string>()

    const cancelPendingRender = () => {
        clearTimeout(pendingRender)
        pendingRender = undefined
    }

    const stopTimer = () => {
        cancelPendingRender()
        clearInterval(timer)
        timer = undefined
    }

    const clearWakeTimer = () => {
        clearTimeout(wakeTimer)
        wakeTimer = undefined
        pendingFinishAt = undefined
    }

    // 后台任务由 pi-subagents 通过进程内事件总线广播；未安装时没有事件，
    // 行为与原来完全一致。事件负载属于外部输入，全部按 unknown 处理。
    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
        typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : undefined

    const belongsToSession = (data: Record<string, unknown>): boolean =>
        sessionIdentities.size === 0 ||
        typeof data.sessionId !== 'string' ||
        sessionIdentities.has(data.sessionId)

    const finishRound = (ctx: ExtensionContext, at = performance.now()) => {
        stopTimer()
        stats.finish(at)
        render(ctx, true)
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

    const safelyEvent = <Args extends unknown[]>(
        handler: (...args: Args) => void,
    ) => {
        return (...args: Args) => {
            try {
                handler(...args)
            } catch {
                // 事件总线上的异常不能拖垮状态栏或宿主。
            }
        }
    }

    const backgroundStarted = (payload: unknown) => {
        const data = asRecord(payload)
        if (!data || typeof data.id !== 'string' || !belongsToSession(data))
            return
        backgroundRuns.add(data.id)
        clearWakeTimer()
        if (stats.isRunning && lastCtx) render(lastCtx, true)
    }

    const backgroundComplete = (payload: unknown) => {
        const data = asRecord(payload)
        if (!data || typeof data.id !== 'string' || !belongsToSession(data))
            return
        if (!backgroundRuns.delete(data.id)) return

        const ctx = lastCtx
        if (!ctx || ctx.mode !== 'tui' || isShutdown || !stats.isRunning) return
        if (backgroundRuns.size > 0) {
            render(ctx, true)
            return
        }

        // 子任务完成后父任务通常会被唤醒并继续；总耗时不应在此期间断掉。
        if (data.triggerTurn !== false) {
            clearWakeTimer()
            const finishedAt = performance.now()
            pendingFinishAt = finishedAt
            const current = setTimeout(
                safely(() => {
                    if (wakeTimer !== current) return
                    wakeTimer = undefined
                    const at = pendingFinishAt ?? performance.now()
                    pendingFinishAt = undefined
                    if (
                        agentActive ||
                        backgroundRuns.size > 0 ||
                        !stats.isRunning
                    )
                        return
                    const visibleCtx = lastCtx
                    if (!visibleCtx || visibleCtx.mode !== 'tui' || isShutdown)
                        return
                    finishRound(visibleCtx, at)
                }),
                WAKE_GRACE_MS,
            )
            wakeTimer = current
            current.unref()
            render(ctx, true)
            return
        }

        if (agentActive) render(ctx, true)
        else finishRound(ctx)
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
            lastCtx = ctx
            stopTimer()
            clearWakeTimer()
            backgroundRuns.clear()
            agentActive = false
            const identities = new Set<string>()
            try {
                const manager = ctx.sessionManager as {
                    getSessionFile?: () => string | undefined
                    getSessionId?: () => string
                }
                const file = manager.getSessionFile?.()
                const id = manager.getSessionId?.()
                if (typeof file === 'string') identities.add(file)
                if (typeof id === 'string') identities.add(id)
            } catch {
                // 会话标识不可用时不过滤后台事件。
            }
            sessionIdentities = identities
            isShutdown = false
            stats = new RoundStats()
            render(ctx, true)
        }),
    )

    pi.on(
        'agent_start',
        safely((_event, ctx) => {
            lastCtx = ctx
            agentActive = true
            clearWakeTimer()
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
            if (!event || typeof event !== 'object') return
            const now = performance.now()
            let hasDelta = false
            switch (event?.type) {
                case 'text_delta':
                case 'thinking_delta':
                case 'toolcall_delta':
                    hasDelta =
                        typeof event.delta === 'string' &&
                        stats.recordDelta(now, event.delta)
                    break
            }
            const usageUpdated =
                'partial' in event
                    ? stats.recordUsage(event.partial?.usage?.output, now)
                    : false
            if (hasDelta || usageUpdated) render(ctx)
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
    // 后台子任务仍在运行时继续计时，直到最后一个任务结束。
    pi.on(
        'agent_settled',
        safely((_event, ctx) => {
            lastCtx = ctx
            agentActive = false
            if (!isActive(ctx)) {
                stopTimer()
                return
            }
            if (backgroundRuns.size > 0 || wakeTimer !== undefined) {
                // 完成事件也可能先于父任务 settled；给批量通知留出同样的唤醒窗口。
                if (wakeTimer !== undefined) pendingFinishAt = performance.now()
                render(ctx, true)
                return
            }
            finishRound(ctx)
        }),
    )

    pi.on(
        'session_shutdown',
        safely((_event, ctx) => {
            lastCtx = ctx
            isShutdown = true
            agentActive = false
            backgroundRuns.clear()
            clearWakeTimer()
            sessionIdentities = new Set()
            stopTimer()
            if (ctx.mode === 'tui') ctx.ui.setStatus(STATUS_KEY, undefined)
        }),
    )

    // 必须放在最后注册，保证函数声明都已初始化。
    pi.events.on(BACKGROUND_STARTED_EVENT, safelyEvent(backgroundStarted))
    pi.events.on(BACKGROUND_COMPLETE_EVENT, safelyEvent(backgroundComplete))
}
