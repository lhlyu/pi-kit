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
        '⚡️\u00a0TPS: 50.0 tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 2m35s',
    )
    assert.deepEqual(colors, [
        { kind: 'rgb', r: 34, g: 197, b: 94 },
        { kind: 'rgb', r: 249, g: 115, b: 22 },
    ])
})

test('使用带变体选择符的默认 emoji 图标，且一个不换行空格不被 Pi 页脚压缩', () => {
    const text = renderStatus(
        { tps: 197.2, elapsedMs: 40_000 },
        {
            fg: (_color, value) => value,
            style: (value) => value,
        },
    )
    // 闪电与沙漏默认是文本样式，必须带变体选择符才按 emoji 显示。
    assert.match(text, /⚡️\u00a0TPS:/u)
    assert.match(text, /⌛️\u00a0TS:/u)
    // 与宿主页脚一致，不能只测试未清理的原始状态文本。
    const footerText = text
        .replace(/[\r\n\t]/g, ' ')
        .replace(/ +/g, ' ')
        .trim()

    assert.equal(
        footerText,
        '⚡️\u00a0TPS: 197.2 tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 40s',
    )
})

test('首个非空 delta 就有实时 TPS，窗口过期后归零', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    assert.equal(stats.snapshot(100).tps, undefined)
    stats.recordDelta(100, 'hello')
    assert.equal(stats.snapshot(100).tps, 10)
    stats.recordDelta(600, 'word '.repeat(20))
    assert.equal(stats.snapshot(1_100).tps, 21)
    assert.equal(stats.snapshot(1_601).tps, 0)
})

test('开头的占位 usage 不阻断估算，持续增长后切换到真实用量', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordUsage(1, 0)
    stats.recordDelta(100, 'hello')
    stats.recordDelta(600, 'world')
    assert.equal(stats.snapshot(600).tps, 4)
    stats.recordUsage(31, 600)
    assert.equal(stats.snapshot(600).tps, 31_000 / 600)
    for (const value of [31, 20, 0, -1, NaN, Infinity, undefined, null, '10']) {
        assert.equal(stats.recordUsage(value, 700), false)
    }
    assert.equal(stats.snapshot(1_000).tps, 31)
    assert.equal(stats.snapshot(1_601).tps, 0)
})

test('空 delta 不创建调用或冻结 TTFT，纯空白仍是输出', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.recordDelta(100, '')
    assert.deepEqual(stats.snapshot(100), { tps: undefined, elapsedMs: 100 })
    stats.prepareMessage(200)
    stats.recordDelta(300, '')
    assert.deepEqual(stats.snapshot(400).ttft, {
        elapsedMs: 200,
        waiting: true,
    })
    stats.recordDelta(500, ' ')
    assert.equal(stats.snapshot(500).tps, 0)
    assert.deepEqual(stats.snapshot(500).ttft, {
        elapsedMs: 300,
        waiting: false,
    })
})

test('平均 TPS 包含首字等待，重复准备和后续 delta 不重置调用起点', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(1_000)
    stats.recordDelta(5_000, 'hello')
    stats.prepareMessage(6_000)
    stats.recordDelta(6_100, 'world')
    stats.endMessage(50, 7_000)
    stats.finish(8_000)
    assert.deepEqual(stats.snapshot(10_000), {
        tps: 50 / 6,
        elapsedMs: 8_000,
        ttft: { elapsedMs: 4_000, waiting: false },
    })
})

test('工具后等待时保留平均值，输出后使用新窗口，结束只显示最近调用平均值', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(100, 'hello')
    stats.recordUsage(10, 100)
    stats.recordUsage(50, 1_000)
    stats.endMessage(50, 2_000)
    stats.prepareMessage(9_000)
    assert.equal(stats.snapshot(10_000).tps, 25)
    stats.recordDelta(10_000, 'world')
    assert.equal(stats.snapshot(10_000).tps, 10)
    stats.endMessage(60, 12_000)
    stats.finish(13_000)
    assert.deepEqual(stats.snapshot(30_000), {
        tps: 20,
        elapsedMs: 13_000,
        ttft: { elapsedMs: 1_000, waiting: false },
    })
})

test('仅最终 usage 的非流式调用也计算平均 TPS，不伪造 TTFT', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(1_000)
    stats.endMessage(50, 3_000)
    stats.finish(4_000)
    assert.deepEqual(stats.snapshot(5_000), { tps: 25, elapsedMs: 4_000 })
})

test('无效最终 usage 保留上次平均值，不保留实时估算值', () => {
    for (const usage of [0, -1, NaN, Infinity, undefined, null, '10']) {
        const stats = new RoundStats()
        stats.start(0)
        stats.prepareMessage(0)
        stats.endMessage(50, 2_000)
        stats.prepareMessage(3_000)
        stats.recordDelta(3_100, 'hello world!')
        assert.equal(stats.snapshot(3_100).tps, 30)
        stats.endMessage(usage, 4_000)
        assert.equal(stats.snapshot(4_000).tps, 25)
    }
})

test('缺失最终 usage、零耗时和空失败不会产生无效平均值', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(100)
    stats.endMessage(10, 100)
    assert.equal(stats.snapshot(100).tps, undefined)
    stats.prepareMessage(200)
    stats.recordDelta(300, 'hello')
    stats.endMessage(undefined, 1_000)
    assert.equal(stats.snapshot(1_000).tps, undefined)
    stats.prepareMessage(1_000)
    stats.endMessage(0, 10_000)
    stats.prepareMessage(10_000)
    stats.endMessage(50, 12_500)
    assert.equal(stats.snapshot(12_500).tps, 20)
})

test('完成调用的平均速度不受最小实时窗口跨度限制', () => {
    const stats = new RoundStats()
    stats.start(0)
    stats.prepareMessage(0)
    stats.recordDelta(10, 'hello')
    stats.endMessage(10, 20)
    assert.equal(stats.snapshot(20).tps, 500)
})

test('中断、重复结束和孤立事件不污染统计，新一轮重置所有状态', () => {
    const stats = new RoundStats()
    stats.recordDelta(0, 'ignored')
    assert.equal(stats.recordUsage(100, 0), false)
    stats.start(0)
    stats.prepareMessage(0)
    stats.endMessage(50, 2_000)
    stats.prepareMessage(3_000)
    stats.recordDelta(3_100, 'hello')
    stats.finish(4_000)
    stats.finish(5_000)
    stats.endMessage(999, 6_000)
    stats.recordDelta(7_000, 'ignored')
    assert.equal(stats.recordUsage(999, 7_000), false)
    assert.deepEqual(stats.snapshot(9_000), {
        tps: 25,
        elapsedMs: 4_000,
        ttft: { elapsedMs: 100, waiting: false },
    })
    stats.start(10_000)
    assert.deepEqual(stats.snapshot(10_000), { tps: undefined, elapsedMs: 0 })
    stats.finish(12_000)
    assert.deepEqual(stats.snapshot(15_000), {
        tps: undefined,
        elapsedMs: 2_000,
    })
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
            '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 0s',
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
    stats.recordDelta(1_330, 'x')
    stats.recordDelta(2_000, 'x')
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
    stats.recordDelta(12_500, 'x')
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
            ).includes(`TTFT: ${expected} ⌛️`),
        )
    }
})
