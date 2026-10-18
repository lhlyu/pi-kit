import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

const WINDOW_MS = 1_000
const MIN_SAMPLE_MS = 100

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

/** 一轮包含多次模型生成和工具执行；TPS 仅使用模型生成耗时。 */
export class RoundStats {
    private startedAt: number | undefined
    private endedAt: number | undefined
    private ttftMs: number | undefined
    private outputTokens = 0
    private generationMs = 0
    private message:
        | {
              startedAt: number
              generationStartedAt: number | undefined
              chunks: number
              samples: number[]
          }
        | undefined

    get isRunning(): boolean {
        return this.startedAt !== undefined && this.endedAt === undefined
    }

    start(now: number): void {
        this.startedAt = now
        this.endedAt = undefined
        this.ttftMs = undefined
        this.outputTokens = 0
        this.generationMs = 0
        this.message = undefined
    }

    prepareMessage(now: number): void {
        if (!this.isRunning || this.message) return
        this.ttftMs = undefined
        this.message = {
            startedAt: now,
            generationStartedAt: undefined,
            chunks: 0,
            samples: [],
        }
    }

    recordDelta(now: number): void {
        this.prepareMessage(now)
        if (!this.message) return

        // 首个非空 delta 才开始生成计时；流式阶段每个 delta 暂计一个 token。
        if (this.message.generationStartedAt === undefined) {
            this.message.generationStartedAt = now
            this.ttftMs = Math.max(0, now - this.message.startedAt)
        }
        this.message.chunks++
        this.message.samples.push(now)
    }

    endMessage(outputTokens: unknown, now: number): void {
        if (!this.message) return

        const tokens =
            typeof outputTokens === 'number' &&
            Number.isFinite(outputTokens) &&
            outputTokens > 0
                ? outputTokens
                : this.message.chunks
        if (tokens > 0) {
            this.outputTokens += tokens
            // 无内容事件时，使用消息起止时间兜底；空失败消息不计入生成耗时。
            this.generationMs += Math.max(
                0,
                now -
                    (this.message.generationStartedAt ??
                        this.message.startedAt),
            )
        }
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

        // 等待后续调用的首字时，沿用本轮已完成的平均速度。
        let tps =
            this.generationMs > 0
                ? (this.outputTokens * 1_000) / this.generationMs
                : undefined
        const message = this.message
        if (message?.generationStartedAt !== undefined) {
            // 只在限频后的刷新中清理窗口，不在每个 delta 上复制数组。
            message.samples = message.samples.filter(
                (time) => time > now - WINDOW_MS,
            )
            const span = Math.max(
                MIN_SAMPLE_MS,
                Math.min(WINDOW_MS, now - message.generationStartedAt),
            )
            tps = (message.samples.length * 1_000) / span
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
        return { tps, elapsedMs, ...(ttft ? { ttft } : {}) }
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
        latency && Number.isFinite(latency.elapsedMs) && latency.elapsedMs >= 0
            ? theme.fg(
                  'accent',
                  `${(latency.elapsedMs / 1_000).toFixed(2)}s${latency.waiting ? '…' : ''}`,
              )
            : theme.fg('dim', '--')

    // 沙漏默认按 emoji 呈现，避免依赖秒表的变体选择符。
    // Pi 页脚会合并普通空格，用一个不换行空格保留图标后的间距。
    return `${theme.fg('dim', '⚡\u00a0TPS:')} ${tps} ${theme.fg('dim', '🚀\u00a0TTFT:')} ${ttft} ${theme.fg('dim', '⏳\u00a0TS:')} ${duration}`
}
