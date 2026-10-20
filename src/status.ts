import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { estimateTokens, SlidingWindow } from './token-speed-window.ts'

const COLORS = {
    cyan: { kind: 'rgb', r: 6, g: 182, b: 212 },
    green: { kind: 'rgb', r: 34, g: 197, b: 94 },
    orange: { kind: 'rgb', r: 249, g: 115, b: 22 },
    pink: { kind: 'rgb', r: 236, g: 72, b: 153 },
    red: { kind: 'rgb', r: 239, g: 68, b: 68 },
} as const

export interface RoundSnapshot {
    tps: number | undefined
    elapsedMs: number
    ttft?: { elapsedMs: number; waiting: boolean }
}

/** 实时 TPS 优先使用 usage，否则估算；完成后的平均速度包含首字等待。 */
export class RoundStats {
    private startedAt: number | undefined
    private endedAt: number | undefined
    private ttftMs: number | undefined
    private lastTps: number | undefined
    private message:
        | {
              startedAt: number
              hasOutput: boolean
              outputTokens: number
              usageUpdates: number
              samples: SlidingWindow
              estimatedSamples: SlidingWindow
          }
        | undefined

    get isRunning(): boolean {
        return this.startedAt !== undefined && this.endedAt === undefined
    }

    start(now: number): void {
        this.startedAt = now
        this.endedAt = undefined
        this.ttftMs = undefined
        this.lastTps = undefined
        this.message = undefined
    }

    prepareMessage(now: number): void {
        if (!this.isRunning || this.message) return
        // 保留上次 TTFT，直到本次调用的首个非空 delta 到达。
        this.message = {
            startedAt: now,
            hasOutput: false,
            outputTokens: 0,
            usageUpdates: 0,
            samples: new SlidingWindow(),
            estimatedSamples: new SlidingWindow(),
        }
    }

    recordDelta(now: number, delta: string): boolean {
        if (delta.length === 0) return false
        this.prepareMessage(now)
        const message = this.message
        if (!message) return false

        if (!message.hasOutput) {
            message.hasOutput = true
            this.ttftMs = Math.max(0, now - message.startedAt)
        }
        message.estimatedSamples.record(estimateTokens(delta), now)
        return true
    }

    recordUsage(outputTokens: unknown, now: number): boolean {
        const message = this.message
        if (
            !message ||
            typeof outputTokens !== 'number' ||
            !Number.isFinite(outputTokens) ||
            outputTokens <= message.outputTokens
        )
            return false

        message.usageUpdates++
        message.samples.record(outputTokens - message.outputTokens, now)
        message.outputTokens = outputTokens
        return true
    }

    endMessage(outputTokens: unknown, now: number): void {
        if (!this.message) return

        const elapsedMs = now - this.message.startedAt
        if (
            typeof outputTokens === 'number' &&
            Number.isFinite(outputTokens) &&
            outputTokens > 0 &&
            elapsedMs > 0
        ) {
            this.lastTps = (outputTokens * 1_000) / elapsedMs
        }
        // 缺失最终 usage 时保留上一条已完成调用的平均速度。
        this.message = undefined
    }

    finish(now: number): void {
        if (!this.isRunning) return
        this.endMessage(0, now)
        this.endedAt = now
    }

    snapshot(now: number): RoundSnapshot {
        const elapsedMs =
            this.startedAt === undefined
                ? 0
                : Math.max(0, (this.endedAt ?? now) - this.startedAt)

        let tps = this.lastTps
        const message = this.message
        // 单次正数可能只是开头的占位 usage，至少增长两次才切换。
        if (message && message.usageUpdates >= 2) {
            tps = message.samples.getTps(now)
        } else if (message?.hasOutput) {
            tps = message.estimatedSamples.getTps(now)
        }
        const ttft =
            this.ttftMs !== undefined
                ? { elapsedMs: this.ttftMs, waiting: false }
                : message
                  ? {
                        elapsedMs: Math.max(0, now - message.startedAt),
                        waiting: true,
                    }
                  : undefined
        return {
            tps,
            elapsedMs,
            ...(ttft ? { ttft } : {}),
        }
    }
}

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms)) return '0s'
    const seconds = Math.floor(Math.max(0, ms) / 1_000)
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** TPS：≥100 cyan，≥40 green，≥30 orange，≥15 pink，其余 red。 */
export function tpsColor(tps: number): keyof typeof COLORS {
    if (tps >= 100) return 'cyan'
    if (tps >= 40) return 'green'
    if (tps >= 30) return 'orange'
    if (tps >= 15) return 'pink'
    return 'red'
}

/** TTFT：<2s cyan，<5s green，<8s orange，<11s pink，其余 red。 */
export function ttftColor(ms: number): keyof typeof COLORS {
    if (ms < 2_000) return 'cyan'
    if (ms < 5_000) return 'green'
    if (ms < 8_000) return 'orange'
    if (ms < 11_000) return 'pink'
    return 'red'
}

/** 耗时：<30s cyan，<2m green，<10m orange，<30m pink，其余 red。 */
export function durationColor(ms: number): keyof typeof COLORS {
    if (ms < 30_000) return 'cyan'
    if (ms < 2 * 60_000) return 'green'
    if (ms < 10 * 60_000) return 'orange'
    if (ms < 30 * 60_000) return 'pink'
    return 'red'
}

export function renderStatus(
    snapshot: RoundSnapshot,
    theme: Pick<ExtensionContext['ui']['theme'], 'fg' | 'style'>,
): string {
    const speed =
        typeof snapshot.tps === 'number' &&
        Number.isFinite(snapshot.tps) &&
        snapshot.tps >= 0
            ? snapshot.tps
            : undefined
    const elapsedMs = Number.isFinite(snapshot.elapsedMs)
        ? Math.max(0, snapshot.elapsedMs)
        : 0
    const tps =
        speed === undefined
            ? theme.fg('dim', '-- tok/s')
            : theme.style(`${speed.toFixed(1)} tok/s`, {
                  fg: COLORS[tpsColor(speed)],
              })
    const duration = theme.style(formatDuration(elapsedMs), {
        fg: COLORS[durationColor(elapsedMs)],
    })

    const latency = snapshot.ttft
    const ttft =
        latency &&
        !latency.waiting &&
        Number.isFinite(latency.elapsedMs) &&
        latency.elapsedMs >= 0
            ? theme.style(`${(latency.elapsedMs / 1_000).toFixed(2)}s`, {
                  fg: COLORS[ttftColor(latency.elapsedMs)],
              })
            : theme.fg('dim', '--')

    // 图标带变体选择符，确保各终端按 emoji 呈现而不是文本样式。
    // Pi 页脚会合并普通空格，用一个不换行空格保留图标后的间距。
    return `${theme.fg('dim', '⚡️\u00a0TPS:')} ${tps} ${theme.fg('dim', '🚀\u00a0TTFT:')} ${ttft} ${theme.fg('dim', '⌛️\u00a0TS:')} ${duration}`
}
