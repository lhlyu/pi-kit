// Adapted from pi-token-speed by Gabriel Sanhueza, MIT.
// See token-speed-LICENSE.md.
const WINDOW_MS = 1_000
const MIN_SPAN_MS = 100
const COMPACTION_THRESHOLD = 5_000

/** pi-token-speed 的滑动窗口；由调用方传入单调时钟，便于宿主集成和测试。 */
export class SlidingWindow {
    private readonly events: { time: number; tokens: number }[] = []
    private windowStartIndex = 0

    record(tokens: number, now: number): void {
        if (!Number.isFinite(tokens) || tokens <= 0) return
        // 未被选为显示来源的窗口也必须定期清理。
        this.prune(now)
        this.events.push({ time: now, tokens })
    }

    /** 窗口内没有样本时由调用方决定回退值，而不是把停顿显示成 0。 */
    isEmpty(now: number): boolean {
        this.prune(now)
        return this.windowStartIndex >= this.events.length
    }

    getTps(now: number): number {
        this.prune(now)
        if (this.windowStartIndex >= this.events.length) return 0

        let tokens = 0
        for (let i = this.windowStartIndex; i < this.events.length; i++) {
            tokens += this.events[i]!.tokens
        }
        let spanStart = this.events[this.windowStartIndex]!.time
        const lastTime = this.events[this.events.length - 1]!.time
        if (spanStart === lastTime && this.windowStartIndex > 0) {
            spanStart = this.events[this.windowStartIndex - 1]!.time
        }
        return (tokens * 1_000) / Math.max(now - spanStart, MIN_SPAN_MS)
    }

    private prune(now: number): void {
        const windowStart = now - WINDOW_MS
        while (
            this.windowStartIndex < this.events.length &&
            this.events[this.windowStartIndex]!.time < windowStart
        ) {
            this.windowStartIndex++
        }
        if (this.windowStartIndex >= COMPACTION_THRESHOLD) {
            // 保留前一个事件，压缩后仍能计算批量到达前的停顿。
            this.events.splice(0, this.windowStartIndex - 1)
            this.windowStartIndex = 1
        }
    }
}

/**
 * 估算输出 token：词/标点计数对中文和普通英文较准，按 4 字符/token 兜底长标识符、
 * URL 和压缩代码。仅用于实时速度，最终仍以服务端 usage 为准。
 */
export function estimateTokens(text: string): number {
    const words = text.match(/\w+|[^\s\w]/g)?.length ?? 0
    const compactLength = text.replace(/\s+/g, '').length
    return Math.max(words, Math.ceil(compactLength / 4))
}
