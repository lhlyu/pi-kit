import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateTokens, SlidingWindow } from '../src/token-speed-window.ts'

test('窗口与示例一致：最小跨度 100ms，按实际时间计算，左边界计入', () => {
    const window = new SlidingWindow()
    assert.equal(window.getTps(0), 0)
    window.record(10, 0)
    assert.equal(window.getTps(0), 100)
    window.record(20, 500)
    assert.equal(window.getTps(500), 60)
    assert.equal(window.getTps(1_000), 30)
    assert.equal(window.getTps(1_501), 0)
})

test('停顿后批量到达时，计算跨度包含上次事件到本次事件的间隔', () => {
    const window = new SlidingWindow()
    window.record(20, 0)
    window.record(250, 5_000)
    window.record(250, 5_000)
    assert.equal(window.getTps(5_000), 100)
    // 后续事件不再属于同一时间戳，恢复实际窗口跨度。
    window.record(10, 5_100)
    assert.equal(window.getTps(5_100), 5_100)
})

test('清理大量过期记录后，仍保留批量到达之前的事件作为跨度起点', () => {
    const window = new SlidingWindow()
    for (let now = 0; now < 6_000; now++) window.record(1, now)
    assert.equal(window.getTps(10_000), 0)
    window.record(100, 10_000)
    assert.equal(window.getTps(10_000), 100_000 / 4_001)
    window.record(20, 10_500)
    assert.equal(window.getTps(10_500), 240)
})

test('持续记录但不读取的备用窗口也会清理，内存不随响应时长持续增长', () => {
    const window = new SlidingWindow()
    for (let now = 0; now < 30_000; now++) window.record(1, now)
    // 不为测试暴露运行时接口；检查已保留记录的数量而非进程内存波动。
    const events = Reflect.get(window, 'events') as unknown[]
    assert.ok(events.length < 7_000)
    assert.equal(window.getTps(29_999), 1_001)
    assert.equal(window.getTps(40_000), 0)
    window.record(10, 40_000)
    assert.equal(window.getTps(40_000), 10_000 / 10_001)
})

test('无效或零 token 数不污染窗口', () => {
    const window = new SlidingWindow()
    for (const tokens of [NaN, Infinity, -1, 0]) window.record(tokens, 0)
    assert.equal(window.getTps(0), 0)
    window.record(2, 100)
    assert.equal(window.getTps(100), 20)
})

test('估算使用词/标点计数并补字符兜底，空白不计入', () => {
    assert.equal(estimateTokens('hello world!'), 3)
    assert.equal(estimateTokens('中文，测试。'), 6)
    assert.equal(estimateTokens('{"x": 1}'), 7)
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(' \n\t'), 0)
})

test('长标识符和 URL 按字符数兜底，纯空白仍为 0', () => {
    assert.equal(estimateTokens('a'.repeat(40)), 10)
    assert.equal(estimateTokens('https://example.com/' + 'x'.repeat(60)), 20)
    assert.equal(estimateTokens('a b c'), 3)
    assert.equal(estimateTokens('   \n\t '), 0)
})
