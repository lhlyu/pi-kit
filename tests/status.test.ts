import assert from 'node:assert/strict'
import test from 'node:test'
import {
    durationColor,
    formatDuration,
    renderStatus,
    RoundStats,
    tpsColor,
    ttftColor,
} from '../src/status.ts'

test('耗时格式化为秒或分钟加秒', () => {
    for (const [ms, text] of [
        [0, '0s'],
        [999, '0s'],
        [59_999, '59s'],
        [60_000, '1m0s'],
        [155_000, '2m35s'],
        [1_800_000, '30m0s'],
        [-1, '0s'],
        [NaN, '0s'],
        [Infinity, '0s'],
    ] as const) {
        assert.equal(formatDuration(ms), text)
    }
})

test('耗时和 TPS 的五色边界固定', () => {
    for (const [ms, color] of [
        [0, 'cyan'],
        [29_999, 'cyan'],
        [30_000, 'green'],
        [119_999, 'green'],
        [120_000, 'orange'],
        [599_999, 'orange'],
        [600_000, 'pink'],
        [1_799_999, 'pink'],
        [1_800_000, 'red'],
    ] as const) {
        assert.equal(durationColor(ms), color)
    }

    for (const [tps, color] of [
        [0, 'red'],
        [14.9, 'red'],
        [15, 'pink'],
        [29.9, 'pink'],
        [30, 'orange'],
        [39.9, 'orange'],
        [40, 'green'],
        [99.9, 'green'],
        [100, 'cyan'],
    ] as const) {
        assert.equal(tpsColor(tps), color)
    }
})

test('显示格式及数值颜色符合约定', () => {
    const colors: unknown[] = []
    const text = renderStatus(
        { tps: 50, elapsedMs: 155_000 },
        {
            fg: (_color, value) => value,
            style: (value, options) => {
                colors.push(options.fg)
                return value
            },
        },
    )

    assert.equal(
        text,
        '⚡\u00a0TPS: 50.0 tok/s 🚀\u00a0TTFT: -- ⏳\u00a0TS: 2m35s',
    )
    assert.deepEqual(colors, [
        { kind: 'rgb', r: 34, g: 197, b: 94 },
        { kind: 'rgb', r: 249, g: 115, b: 22 },
    ])
})

test('使用默认 emoji 图标，且一个不换行空格不被 Pi 页脚压缩', () => {
    const text = renderStatus(
        { tps: 197.2, elapsedMs: 40_000 },
        {
            fg: (_color, value) => value,
            style: (value) => value,
        },
    )
    assert.doesNotMatch(text, /\uFE0F/u)
    // 与宿主页脚一致，不能只测试未清理的原始状态文本。
    const footerText = text
        .replace(/[\r\n\t]/g, ' ')
        .replace(/ +/g, ' ')
        .trim()

    assert.equal(
        footerText,
        '⚡\u00a0TPS: 197.2 tok/s 🚀\u00a0TTFT: -- ⏳\u00a0TS: 40s',
    )
})

test('服务端累计 usage 使用一秒窗口，采样不足时显示占位值，停顿时归零', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordUsage(10, 1_000)
    assert.equal(stats.snapshot(1_000).tps, undefined)

    stats.recordUsage(30, 1_500)
    stats.recordUsage(30, 1_600)
    stats.recordUsage(20, 1_700)
    assert.equal(stats.snapshot(1_500).tps, undefined)
    assert.equal(stats.snapshot(1_999).tps, undefined)
    assert.equal(stats.snapshot(2_000).tps, 20)
    assert.equal(stats.snapshot(2_500).tps, 0)

    // 长时间停顿后到来一个片段，仍使用完整的一秒窗口。
    stats.recordUsage(35, 10_000)
    assert.equal(stats.snapshot(10_000).tps, 5)
})

test('批量到达的 delta 在采样不足时不显示尖峰，最终 TPS 包含缓冲等待', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    for (let i = 0; i < 200; i++) stats.recordDelta(5_000)
    assert.equal(stats.snapshot(5_000).tps, undefined)
    assert.equal(stats.snapshot(5_500).tps, undefined)
    stats.endMessage(1_000, 5_730)
    stats.finish(6_000)
    assert.equal(stats.snapshot(6_000).tps, 1_000_000 / 5_730)
})

test('最终 TPS 使用上一条调用的 usage，包含首字等待但排除工具执行', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(1_000)
    stats.recordDelta(1_900)
    stats.endMessage(50, 3_000)

    // 工具执行后再次调用：仅显示最近一次调用的 60 tokens / 3 秒。
    stats.prepareMessage(9_000)
    stats.recordDelta(10_000)
    stats.endMessage(60, 12_000)
    stats.finish(13_000)

    assert.deepEqual(stats.snapshot(30_000), {
        tps: 20,
        elapsedMs: 13_000,
        ttft: { elapsedMs: 1000, waiting: false },
    })
})

test('无 usage 时不使用片段估算，中断和重复结束不会污染统计', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(100)
    stats.recordDelta(900)
    stats.finish(1_100)
    stats.finish(5_000)
    stats.endMessage(999, 6_000)
    stats.recordDelta(7_000)

    assert.deepEqual(stats.snapshot(9_000), {
        tps: undefined,
        elapsedMs: 1_100,
        ttft: { elapsedMs: 100, waiting: false },
    })
})

test('新一轮重置统计，没有输出时不沿用上一轮速度', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.recordDelta(100)
    stats.endMessage(50, 1_100)
    stats.finish(2_000)

    stats.start(10_000)
    assert.deepEqual(stats.snapshot(10_000), { tps: undefined, elapsedMs: 0 })
    stats.finish(12_000)
    assert.deepEqual(stats.snapshot(15_000), {
        tps: undefined,
        elapsedMs: 2_000,
    })
})

test('平均 TPS 从调用开始计时，重复准备消息和后续 delta 不重置起点', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(1_000)
    assert.deepEqual(stats.snapshot(4_000), {
        tps: undefined,
        elapsedMs: 4_000,
        ttft: { elapsedMs: 3_000, waiting: true },
    })
    stats.recordDelta(5_000)
    stats.prepareMessage(6_000)
    stats.recordDelta(6_100)
    stats.endMessage(50, 7_000)
    stats.finish(8_000)

    assert.deepEqual(stats.snapshot(10_000), {
        tps: 50 / 6,
        elapsedMs: 8_000,
        ttft: { elapsedMs: 4000, waiting: false },
    })
})

test('后续模型调用等待首字和采样不足时沿用已完成平均速度，不闪回占位符', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(100)
    stats.endMessage(50, 2_100)

    stats.prepareMessage(3_000)
    assert.deepEqual(stats.snapshot(5_000), {
        tps: 50_000 / 2_100,
        elapsedMs: 5_000,
        ttft: { elapsedMs: 100, waiting: false },
    })

    stats.recordDelta(5_000)
    assert.equal(stats.snapshot(5_000).tps, 50_000 / 2_100)
    stats.recordDelta(5_500)
    assert.equal(stats.snapshot(5_999).tps, 50_000 / 2_100)
    assert.equal(stats.snapshot(6_000).tps, 50_000 / 2_100)
    assert.equal(stats.snapshot(6_500).tps, 50_000 / 2_100)
})

test('后续调用使用各自平均速度，空失败和缺失 usage 保留上一次结果', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(100)
    stats.endMessage(50, 2_000)

    stats.prepareMessage(3_000)
    stats.recordDelta(3_100)
    assert.equal(stats.snapshot(3_200).tps, 25)
    stats.endMessage(10, 3_500)
    assert.equal(stats.snapshot(3_500).tps, 20)

    stats.prepareMessage(4_000)
    stats.endMessage(0, 5_000)
    assert.equal(stats.snapshot(5_000).tps, 20)

    stats.prepareMessage(6_000)
    stats.recordDelta(6_100)
    assert.equal(stats.snapshot(7_099).tps, 20)
    assert.equal(stats.snapshot(7_100).tps, 20)
    stats.endMessage(undefined, 8_000)
    assert.equal(stats.snapshot(8_000).tps, 20)
})

test('最终平均 TPS 包含首字等待，不受实时窗口最小采样限制', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(100)
    stats.endMessage(10, 120)
    stats.finish(200)

    assert.deepEqual(stats.snapshot(300), {
        tps: 10_000 / 120,
        elapsedMs: 200,
        ttft: { elapsedMs: 100, waiting: false },
    })
})

test('空的失败消息不会拉低下一次成功生成的平均 TPS', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(100)
    stats.endMessage(0, 10_100)
    stats.prepareMessage(10_500)
    stats.recordDelta(11_000)
    stats.endMessage(50, 13_000)
    stats.finish(14_000)

    assert.deepEqual(stats.snapshot(20_000), {
        tps: 20,
        elapsedMs: 14_000,
        ttft: { elapsedMs: 500, waiting: false },
    })
})

test('无效 usage 不产生 NaN 或 Infinity', () => {
    for (const usage of [0, -1, NaN, Infinity, undefined, null, '10']) {
        const stats = new RoundStats()
        stats.start(0)
        stats.recordDelta(0)
        stats.endMessage(usage, 0)
        stats.finish(0)
        // 未测得生成耗时，显示占位值，而不是捏造平均值或除以零。
        assert.deepEqual(stats.snapshot(0), {
            tps: undefined,
            elapsedMs: 0,
            ttft: { elapsedMs: 0, waiting: false },
        })
    }
})

test('无效 usage 不使用片段估算', () => {
    for (const usage of [undefined, null, '10', NaN, Infinity, -1]) {
        const stats = new RoundStats()
        stats.start(0)
        stats.recordDelta(0)
        stats.recordDelta(500)
        stats.endMessage(usage, 1_000)
        stats.finish(2_000)
        assert.deepEqual(stats.snapshot(3_000), {
            tps: undefined,
            elapsedMs: 2_000,
            ttft: { elapsedMs: 0, waiting: false },
        })
    }
})

test('高频窗口跨越多次清理后仍准确，窗口左边界不计入', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    for (let now = 0; now < 10_000; now++) stats.recordUsage(now + 1, now)
    assert.equal(stats.snapshot(9_999).tps, 1_000)
    assert.equal(stats.snapshot(10_000).tps, 999)
    assert.equal(stats.snapshot(10_999).tps, 0)
    stats.recordUsage(10_001, 20_000)
    assert.equal(stats.snapshot(20_000).tps, 1)
})

test('显示层对无效 TPS 和耗时安全降级', () => {
    const colors: unknown[] = []
    const theme = {
        fg: (_color: string, text: string) => text,
        style: (text: string, options: { fg?: unknown }) => {
            colors.push(options.fg)
            return text
        },
    }
    for (const tps of [NaN, Infinity, -Infinity, -1]) {
        colors.length = 0
        assert.equal(
            renderStatus({ tps, elapsedMs: NaN }, theme),
            '⚡\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⏳\u00a0TS: 0s',
        )
        assert.deepEqual(colors, [{ kind: 'rgb', r: 6, g: 182, b: 212 }])
    }
})

test('TTFT 首次等待时递增，后续等待和失败保留旧值，首 token 到达才更新', () => {
    const stats = new RoundStats()
    assert.equal(stats.snapshot(0).ttft, undefined)
    stats.start(0)
    stats.prepareMessage(100)
    assert.deepEqual(stats.snapshot(600).ttft, {
        elapsedMs: 500,
        waiting: true,
    })
    stats.prepareMessage(700)
    stats.recordDelta(1_330)
    stats.recordDelta(2_000)
    assert.deepEqual(stats.snapshot(3_000).ttft, {
        elapsedMs: 1_230,
        waiting: false,
    })
    stats.endMessage(50, 3_000)
    assert.deepEqual(stats.snapshot(9_000).ttft, {
        elapsedMs: 1_230,
        waiting: false,
    })
    stats.prepareMessage(10_000)
    assert.deepEqual(stats.snapshot(10_500).ttft, {
        elapsedMs: 1_230,
        waiting: false,
    })
    stats.endMessage(0, 11_000)
    assert.deepEqual(stats.snapshot(11_000).ttft, {
        elapsedMs: 1_230,
        waiting: false,
    })
    stats.prepareMessage(12_000)
    stats.recordDelta(12_500)
    assert.deepEqual(stats.snapshot(12_500).ttft, {
        elapsedMs: 500,
        waiting: false,
    })
    stats.endMessage(10, 12_600)
    stats.prepareMessage(12_700)
    stats.finish(13_000)
    assert.deepEqual(stats.snapshot(20_000).ttft, {
        elapsedMs: 500,
        waiting: false,
    })
    stats.start(30_000)
    assert.equal(stats.snapshot(30_000).ttft, undefined)
})

test('TTFT 五色边界固定，等待时不显示耗时', () => {
    for (const [elapsedMs, color, rgb] of [
        [0, 'cyan', [6, 182, 212]],
        [1_999, 'cyan', [6, 182, 212]],
        [2_000, 'green', [34, 197, 94]],
        [4_999, 'green', [34, 197, 94]],
        [5_000, 'orange', [249, 115, 22]],
        [7_999, 'orange', [249, 115, 22]],
        [8_000, 'pink', [236, 72, 153]],
        [10_999, 'pink', [236, 72, 153]],
        [11_000, 'red', [239, 68, 68]],
    ] as const) {
        assert.equal(ttftColor(elapsedMs), color)
        for (const waiting of [true, false]) {
            const text = `${(elapsedMs / 1_000).toFixed(2)}s`
            let actualColor: unknown
            renderStatus(
                { tps: undefined, elapsedMs: 0, ttft: { elapsedMs, waiting } },
                {
                    fg: (_color, value) => value,
                    style: (value, options) => {
                        if (value === text) actualColor = options.fg
                        return value
                    },
                },
            )
            const [r, g, b] = rgb
            assert.deepEqual(
                actualColor,
                waiting ? undefined : { kind: 'rgb', r, g, b },
            )
        }
    }
})

test('TTFT 显示两位小数，等待和异常值显示占位值', () => {
    const theme = {
        fg: (_color: string, text: string) => text,
        style: (text: string) => text,
    }
    for (const [elapsedMs, waiting, expected] of [
        [1_230, true, '--'],
        [1_230, false, '1.23s'],
        [0, false, '0.00s'],
        [NaN, true, '--'],
        [Infinity, false, '--'],
        [-1, false, '--'],
    ] as const) {
        assert.ok(
            renderStatus(
                {
                    tps: undefined,
                    elapsedMs: 0,
                    ttft: { elapsedMs, waiting },
                },
                theme,
            ).includes(`TTFT: ${expected} ⏳`),
        )
    }
})
