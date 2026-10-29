import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import piKit from '../src/status-extension.ts'

function harness(t: TestContext, mode: ExtensionContext['mode'] = 'tui') {
    const handlers = new Map<
        string,
        (event: unknown, ctx: ExtensionContext) => unknown
    >()
    const eventHandlers = new Map<string, (data: unknown) => void>()
    const updates: (string | undefined)[] = []
    let now = 0
    let sessionId = 'session-1'
    let sessionFile: string | undefined

    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const intervals = t.mock.method(globalThis, 'setInterval')
    const timeouts = t.mock.method(globalThis, 'setTimeout')
    t.mock.method(performance, 'now', () => now)

    // 仅模拟本扩展使用的宿主接口，不依赖个人 Pi 配置。
    const pi = {
        on(
            name: string,
            handler: (event: unknown, ctx: ExtensionContext) => unknown,
        ) {
            handlers.set(name, handler)
            return () => handlers.delete(name)
        },
        events: {
            on(channel: string, handler: (data: unknown) => void) {
                eventHandlers.set(channel, handler)
                return () => eventHandlers.delete(channel)
            },
            emit(channel: string, data: unknown) {
                eventHandlers.get(channel)?.(data)
            },
        },
    } as unknown as ExtensionAPI
    const ctx = {
        mode,
        sessionManager: {
            getSessionId: () => sessionId,
            getSessionFile: () => sessionFile,
        },
        ui: {
            theme: {
                fg: (_color: string, text: string) => text,
                style: (text: string) => text,
            },
            setStatus(key: string, text: string | undefined) {
                assert.equal(key, 'pi-kit:stats')
                updates.push(text)
            },
        },
    } as unknown as ExtensionContext

    piKit(pi)

    return {
        handlers,
        eventHandlers,
        updates,
        ctx,
        intervals,
        timeouts,
        emit(name: string, event: unknown = {}) {
            // 与宿主一致：未订阅的事件直接略过，行为断言负责验证订阅是否完整。
            handlers.get(name)?.(event, ctx)
        },
        emitEvent(name: string, payload: unknown) {
            eventHandlers.get(name)?.(payload)
        },
        setSessionId(id: string) {
            sessionId = id
        },
        setSessionFile(file: string | undefined) {
            sessionFile = file
        },
        tick(ms: number) {
            now += ms
            t.mock.timers.tick(ms)
        },
    }
}

test('工厂只注册必要事件，不启动计时器或提供配置命令', (t) => {
    const h = harness(t)
    assert.deepEqual(
        [...h.handlers.keys()],
        [
            'session_start',
            'agent_start',
            'turn_start',
            'message_update',
            'message_end',
            'agent_settled',
            'session_shutdown',
        ],
    )
    assert.deepEqual(
        [...h.eventHandlers.keys()],
        ['subagent:async-started', 'subagent:async-complete'],
    )
    h.tick(5_000)
    assert.equal(h.updates.length, 0)
    assert.equal(h.intervals.mock.callCount(), 0)

    h.emit('session_start')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 0s',
    )
    h.tick(5_000)
    assert.equal(h.updates.length, 1)
})

test('等待首字时持续计时，结束后强制更新且停止计时器', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 1s$/)

    h.emit('message_update', { assistantMessageEvent: { type: 'text_start' } })
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    })
    h.tick(2_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    h.emit('agent_settled')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: 25.0 tok/s 🚀\u00a0TTFT: 0.00s ⌛️\u00a0TS: 3s',
    )

    const count = h.updates.length
    h.tick(10_000)
    assert.equal(h.updates.length, count)
})

test('工具后的调用等待时保留上次 TPS，首个 delta 就能实时估算', (t) => {
    const h = harness(t)
    const delta = {
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
    }
    h.emit('agent_start')
    h.emit('turn_start')
    h.emit('message_update', delta)
    h.tick(2_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    assert.match(h.updates.at(-1) ?? '', /TPS: 25\.0 tok\/s/)

    h.tick(3_000)
    h.emit('turn_start')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TPS: 25\.0 tok\/s/)
    h.emit('message_update', delta)
    h.tick(33)
    assert.match(h.updates.at(-1) ?? '', /TPS: 10\.0 tok\/s/)
    h.tick(467)
    h.emit('message_update', delta)
    assert.match(h.updates.at(-1) ?? '', /TPS: 4\.0 tok\/s/)
    h.tick(500)
    assert.match(h.updates.at(-1) ?? '', /TPS: 2\.0 tok\/s/)
    h.emit('agent_settled')
    assert.match(h.updates.at(-1) ?? '', /TPS: 25\.0 tok\/s/)
})

test('文本、思考和工具参数都参与实时估算，工具结果和空 delta 不计入', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    for (const type of ['text_delta', 'thinking_delta', 'toolcall_delta']) {
        h.emit('message_update', {
            assistantMessageEvent: { type, delta: 'x' },
        })
    }
    h.tick(33)
    assert.match(h.updates.at(-1) ?? '', /TPS: 30\.0 tok\/s/)
    const count = h.updates.length
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: '' },
    })
    h.emit('message_end', {
        message: { role: 'toolResult', usage: { output: 999 } },
    })
    assert.equal(h.updates.length, count)
    h.tick(1_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 0 } },
    })
    h.emit('agent_settled')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: 0.00s ⌛️\u00a0TS: 1s',
    )
})

test('流式 usage 按 token 增量统计，结束后使用单次平均值，缺失 usage 保留上次结果', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    const update = (output: unknown, delta = 'many tokens in one delta') =>
        h.emit('message_update', {
            assistantMessageEvent: {
                type: 'text_delta',
                delta,
                partial: { usage: { output } },
            },
        })
    update(10)
    h.tick(500)
    update(40)
    update(40)
    update(NaN)
    h.tick(500)
    assert.match(h.updates.at(-1) ?? '', /TPS: 40\.0 tok\/s/)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    assert.match(h.updates.at(-1) ?? '', /TPS: 50\.0 tok\/s/)
    h.tick(5_000)
    h.emit('turn_start')
    update(undefined)
    h.tick(2_000)
    assert.match(h.updates.at(-1) ?? '', /TPS: 50\.0 tok\/s/)
    h.emit('message_end', { message: { role: 'assistant' } })
    h.emit('agent_settled')
    assert.match(h.updates.at(-1) ?? '', /TPS: 50\.0 tok\/s/)
})

test('首个 delta 的 usage 不丢失，空 delta 和非 delta 更新也能刷新 usage', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    // 无 turn_start 时仍由首个非空 delta 创建统计。
    h.emit('message_update', {
        assistantMessageEvent: {
            type: 'text_delta',
            delta: 'hello',
            partial: { usage: { output: 10 } },
        },
    })
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TPS: 2\.0 tok\/s/)
    h.tick(100)
    h.emit('message_update', {
        assistantMessageEvent: {
            type: 'text_delta',
            delta: '',
            partial: { usage: { output: 40 } },
        },
    })
    h.tick(33)
    assert.match(h.updates.at(-1) ?? '', /TPS: 26\.5 tok\/s/)
    h.tick(100)
    h.emit('message_update', {
        assistantMessageEvent: {
            type: 'text_end',
            partial: { usage: { output: 60 } },
        },
    })
    assert.match(h.updates.at(-1) ?? '', /TPS: 375\.9 tok\/s/)
    h.emit('agent_settled')
    // 无最终 usage 时，不把实时值当成已完成调用的平均值。
    assert.match(h.updates.at(-1) ?? '', /TPS: -- tok\/s/)
})

test('只有首部占位 usage 和最终 usage 的接口也能实时更新估算', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    const update = (type: string, delta: string) =>
        h.emit('message_update', {
            assistantMessageEvent: {
                type,
                delta,
                partial: { usage: { output: 1 } },
            },
        })
    update('text_delta', 'hello')
    h.tick(500)
    update('thinking_delta', 'word '.repeat(20))
    h.tick(500)
    assert.match(h.updates.at(-1) ?? '', /TPS: 22\.0 tok\/s/)
    h.tick(100)
    update('toolcall_delta', 'word '.repeat(20))
    h.tick(33)
    assert.match(h.updates.at(-1) ?? '', /TPS: 63\.2 tok\/s/)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 100 } },
    })
    assert.doesNotMatch(h.updates.at(-1) ?? '', /≈/)
    assert.match(h.updates.at(-1) ?? '', /TPS: 88\.3 tok\/s/)
    h.emit('agent_settled')
})

test('会话关闭和重复关闭均可安全清理，后续会话不残留统计', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(1_000)
    h.emit('session_shutdown')
    h.emit('session_shutdown')
    assert.equal(h.updates.at(-1), undefined)

    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)

    h.emit('session_start')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 0s',
    )
})

test('同一轮自动重试不会重置耗时，也不会重复创建计时器', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(1_000)
    h.emit('agent_end')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 2s$/)
    h.emit('agent_start')
    assert.equal(h.intervals.mock.callCount(), 1)
    const count = h.updates.length
    h.tick(1_000)
    assert.equal(h.updates.length, count + 1)
    assert.match(h.updates.at(-1) ?? '', /TS: 3s$/)
    h.emit('agent_settled')
})

test('只有最终 usage 的消息也参与统计，不会漏掉 token', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(1_000)
    h.emit('turn_start')
    h.emit('message_start', { message: { role: 'assistant' } })
    h.tick(2_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    h.emit('agent_settled')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: 25.0 tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 3s',
    )
})

test('TTFT 完整事件链：首次等待、首字冻结、后续等待保留、新值更新和取消', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    assert.match(h.updates.at(-1) ?? '', /TTFT: -- ⌛️/)
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TTFT: -- ⌛️/)
    h.tick(230)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'thinking_delta', delta: 'x' },
    })
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.23s ⌛️/)
    h.tick(2_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    h.tick(5_000)
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.23s ⌛️/)
    h.emit('turn_start')
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.23s ⌛️/)
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.23s ⌛️/)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: '' },
    })
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.23s ⌛️/)
    h.tick(500)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
    })
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.50s ⌛️/)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 10 } },
    })
    h.emit('turn_start')
    h.tick(1_000)
    h.emit('agent_settled', { aborted: true })
    assert.match(h.updates.at(-1) ?? '', /TTFT: 1\.50s ⌛️/)
    h.emit('agent_start')
    h.emit('turn_start')
    assert.match(h.updates.at(-1) ?? '', /TTFT: -- ⌛️/)
})

test('上一轮真正结束后，新请求会重置耗时和 TPS', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(3_000)
    h.emit('agent_settled')
    h.tick(5_000)
    h.emit('agent_start')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 0s',
    )
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 1s$/)
    h.emit('agent_settled')
})

test('取消或报错后结算并停止计时器', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    h.emit('message_start', { message: { role: 'assistant' } })
    h.tick(2_000)
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 0 } },
    })
    h.emit('agent_end')
    h.emit('agent_settled', { aborted: true })
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 2s',
    )
    const count = h.updates.length
    h.tick(10_000)
    assert.equal(h.updates.length, count)
})

for (const mode of ['rpc', 'json', 'print'] as const) {
    test(`${mode} 模式不更新终端状态，也不启动计时器`, (t) => {
        const h = harness(t, mode)
        h.emit('session_start')
        h.emit('agent_start')
        h.emit('turn_start')
        h.emit('message_start', { message: { role: 'assistant' } })
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        })
        h.tick(1_000)
        h.emit('message_end', {
            message: { role: 'assistant', usage: { output: 10 } },
        })
        h.emit('agent_end')
        h.emit('agent_settled')
        h.emit('session_shutdown')
        assert.equal(h.updates.length, 0)
        assert.equal(h.intervals.mock.callCount(), 0)
    })
}

for (const type of ['text', 'thinking', 'toolcall']) {
    test(`${type}_start 和空 delta 不提前结束首字等待`, (t) => {
        const h = harness(t)
        h.emit('agent_start')
        h.emit('turn_start')
        h.tick(1_000)
        h.emit('message_start', { message: { role: 'assistant' } })
        h.emit('message_update', {
            assistantMessageEvent: { type: `${type}_start` },
        })
        h.tick(3_000)
        h.emit('message_update', {
            assistantMessageEvent: { type: `${type}_delta`, delta: '' },
        })
        assert.match(h.updates.at(-1) ?? '', /TPS: -- tok\/s/)

        h.tick(1_000)
        h.emit('message_update', {
            assistantMessageEvent: { type: `${type}_delta`, delta: 'x' },
        })
        h.tick(2_000)
        h.emit('message_end', {
            message: { role: 'assistant', usage: { output: 50 } },
        })
        h.emit('agent_settled')
        assert.equal(
            h.updates.at(-1),
            '⚡️\u00a0TPS: 7.1 tok/s 🚀\u00a0TTFT: 5.00s ⌛️\u00a0TS: 7s',
        )
    })
}

test('仅最终 usage 的消息以 turn_start 兜底，不漏算且排除工具耗时', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    h.tick(2_000)
    // 宿主可以在请求完成时连续派发 message_start / message_end。
    h.emit('message_start', { message: { role: 'assistant' } })
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    assert.match(h.updates.at(-1) ?? '', /TPS: 25\.0 tok\/s/)

    h.tick(8_000)
    h.emit('turn_start')
    h.tick(2_000)
    h.emit('message_start', { message: { role: 'assistant' } })
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 50 } },
    })
    h.emit('agent_settled')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: 25.0 tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 12s',
    )
})

test('缺失或异常事件字段被忽略，不抛异常也不污染有效统计', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('turn_start')
    h.emit('message_start', { message: { role: 'assistant' } })
    for (const event of [null, {}, { message: null }]) {
        assert.doesNotThrow(() => h.emit('message_start', event))
        assert.doesNotThrow(() => h.emit('message_update', event))
        assert.doesNotThrow(() => h.emit('message_end', event))
    }
    for (const assistantMessageEvent of [null, false, 1, 'invalid']) {
        h.emit('message_update', { assistantMessageEvent })
    }
    const beforeTick = h.updates.length
    h.tick(1_000)
    assert.equal(h.updates.length, beforeTick + 1)
    for (const delta of [undefined, null, 123, {}, '']) {
        assert.doesNotThrow(() =>
            h.emit('message_update', {
                assistantMessageEvent: { type: 'text_delta', delta },
            }),
        )
    }
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
    })
    h.tick(1_000)
    h.emit('message_end', { message: { role: 'assistant' } })
    h.emit('agent_settled')
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: 1.00s ⌛️\u00a0TS: 2s',
    )
})

for (const event of [
    'session_start',
    'agent_start',
    'message_update',
    'message_end',
    'agent_settled',
    'session_shutdown',
]) {
    test(`${event} 的状态栏异常不会外抛，且停止定时器`, (t) => {
        const h = harness(t)
        h.emit('agent_start')
        h.emit('turn_start')
        h.emit('message_start', { message: { role: 'assistant' } })
        h.tick(200)
        const status = t.mock.method(h.ctx.ui, 'setStatus', () => {
            throw new Error('状态栏不可用')
        })
        assert.doesNotThrow(() =>
            h.emit(event, {
                message: { role: 'assistant', usage: { output: 10 } },
                assistantMessageEvent: { type: 'text_delta', delta: 'x' },
            }),
        )
        status.mock.restore()
        const count = h.updates.length
        h.tick(5_000)
        assert.equal(h.updates.length, count)
    })
}

test('定时器中的主题异常被内部消化，后续轮次可以恢复', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    const theme = t.mock.method(h.ctx.ui.theme, 'style', () => {
        throw new Error('主题渲染失败')
    })
    assert.doesNotThrow(() => h.tick(1_000))
    theme.mock.restore()
    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)

    h.emit('agent_settled')
    h.emit('agent_start')
    h.tick(1_000)
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 1s',
    )
    h.emit('agent_settled')
})

test('关闭后的迟到事件不恢复状态或计时器，新会话仍可正常开始', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('session_shutdown')
    const count = h.updates.length
    const timers = h.intervals.mock.callCount()
    h.emit('agent_start')
    h.emit('turn_start')
    h.emit('message_start', { message: { role: 'assistant' } })
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'late' },
    })
    h.emit('message_end', {
        message: { role: 'assistant', usage: { output: 99 } },
    })
    h.emit('agent_settled')
    h.tick(5_000)
    assert.equal(h.updates.length, count)
    assert.equal(h.intervals.mock.callCount(), timers)

    h.emit('session_start')
    h.emit('agent_start')
    h.tick(1_000)
    assert.equal(
        h.updates.at(-1),
        '⚡️\u00a0TPS: -- tok/s 🚀\u00a0TTFT: -- ⌛️\u00a0TS: 1s',
    )
    h.emit('agent_settled')
})

test('计时器创建异常被消化，恢复后可重新开始', (t) => {
    const h = harness(t)
    const interval = t.mock.method(globalThis, 'setInterval', () => {
        throw new Error('无法创建计时器')
    })
    assert.doesNotThrow(() => h.emit('agent_start'))
    interval.mock.restore()
    h.emit('agent_settled')
    h.emit('agent_start')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 1s$/)
    h.emit('agent_settled')
})

test('不涉及渲染的回调发生异常也不会传递给宿主', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    t.mock.method(performance, 'now', () => {
        throw new Error('时钟不可用')
    })
    assert.doesNotThrow(() => h.emit('turn_start'))
    assert.doesNotThrow(() => h.tick(5_000))
})

test('33ms 内合并 delta，最后一个 delta 无需后续事件也会刷新', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    const count = h.updates.length
    for (let i = 0; i < 3; i++) {
        h.tick(10)
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        })
    }
    assert.equal(h.updates.length, count)
    assert.equal(h.timeouts.mock.callCount(), 1)
    h.tick(2)
    assert.equal(h.updates.length, count)
    h.tick(1)
    assert.equal(h.updates.length, count + 1)
    assert.match(h.updates.at(-1) ?? '', /TPS: 30\.0 tok\/s/)
    h.tick(100)
    assert.equal(h.updates.length, count + 1)
    h.emit('agent_settled')
})

test('超过 33ms 的 delta 立即刷新，窗口内只安排一次尾部刷新', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(100)
    const count = h.updates.length
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'a' },
    })
    assert.equal(h.updates.length, count + 1)
    assert.equal(h.timeouts.mock.callCount(), 0)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'b' },
    })
    h.tick(33)
    assert.equal(h.updates.length, count + 2)
    h.emit('agent_settled')
})

test('定时器与流式更新共用节流，尾部刷新不重复执行', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.tick(990)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'a' },
    })
    const count = h.updates.length
    h.tick(10)
    assert.equal(h.updates.length, count)
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'b' },
    })
    assert.equal(h.timeouts.mock.callCount(), 1)
    h.tick(23)
    assert.equal(h.updates.length, count + 1)
    h.tick(977)
    assert.equal(h.updates.length, count + 2)
    h.emit('agent_settled')
})

for (const event of [
    'message_end',
    'agent_settled',
    'session_shutdown',
    'session_start',
]) {
    test(`${event} 取消待刷新任务，不残留尾部更新`, (t) => {
        const h = harness(t)
        h.emit('agent_start')
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'a' },
        })
        assert.equal(h.timeouts.mock.callCount(), 1)
        h.emit(event, {
            message: { role: 'assistant', usage: { output: 1 } },
        })
        const count = h.updates.length
        h.tick(33)
        assert.equal(h.updates.length, count)
        h.emit('session_shutdown')
    })
}

test('尾部刷新异常被隔离，停止所有计时器，后续轮次可恢复', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'a' },
    })
    const status = t.mock.method(h.ctx.ui, 'setStatus', () => {
        throw new Error('状态栏不可用')
    })
    assert.doesNotThrow(() => h.tick(33))
    status.mock.restore()
    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
    h.emit('agent_settled')
    h.emit('agent_start')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 1s$/)
    h.emit('agent_settled')
})

test('持续高频 delta 仍受 33ms 限制，停止后只补一次尾部刷新', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    for (let i = 0; i < 1_000; i++) {
        h.tick(1)
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        })
        assert.equal(h.updates.length, 1 + Math.floor((i + 1) / 33))
    }
    h.tick(23)
    assert.equal(h.updates.length, 32)
    const tasks = h.timeouts.mock.callCount()
    h.tick(100)
    assert.equal(h.updates.length, 32)
    assert.equal(h.timeouts.mock.callCount(), tasks)
    h.emit('agent_settled')
})

test('尾部计时器略早唤醒时补足间隔，不提前刷新或丢失更新', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'x' },
    })
    const clock = t.mock.method(performance, 'now', () => 32.5)
    h.tick(33)
    assert.equal(h.updates.length, 1)
    assert.equal(h.timeouts.mock.callCount(), 2)
    clock.mock.restore()
    h.tick(1)
    assert.equal(h.updates.length, 2)
    h.emit('agent_settled')
})

test('尾部计时器创建失败时异常不外抛，且停止周期刷新', (t) => {
    const h = harness(t)
    h.emit('agent_start')
    const timeout = t.mock.method(globalThis, 'setTimeout', () => {
        throw new Error('无法创建尾部计时器')
    })
    assert.doesNotThrow(() =>
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        }),
    )
    timeout.mock.restore()
    h.tick(5_000)
    assert.equal(h.updates.length, 1)
    h.emit('agent_settled')
    h.emit('agent_start')
    h.emit('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'y' },
    })
    const count = h.updates.length
    h.tick(33)
    assert.equal(h.updates.length, count + 1)
    h.emit('agent_settled')
})

test('未开始和已结束轮次的孤立消息事件不刷新状态', (t) => {
    const h = harness(t)
    h.emit('session_start')
    for (let round = 0; round < 2; round++) {
        const count = h.updates.length
        h.emit('message_start', { message: { role: 'assistant' } })
        h.emit('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        })
        h.emit('message_end', {
            message: { role: 'assistant', usage: { output: 99 } },
        })
        h.emit('agent_settled')
        assert.equal(h.updates.length, count)
        h.emit('agent_start')
        h.tick(1_000)
        h.emit('agent_settled')
    }
})

test('后台子任务运行期间 TS 继续计时，最后一个任务结束后冻结', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.tick(1_000)
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.emit('agent_settled')
    h.tick(2_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 3s$/)

    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
        triggerTurn: false,
    })
    assert.match(h.updates.at(-1) ?? '', /TS: 3s$/)
    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
})

test('后台任务完成后父任务被唤醒时，总耗时连续累计且不重置', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.tick(2_000)
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
        triggerTurn: true,
    })
    h.emit('agent_start')
    h.tick(1_000)
    h.emit('agent_settled')
    assert.match(h.updates.at(-1) ?? '', /TS: 4s$/)

    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
})

test('后台任务完成但未唤醒父任务时，按完成时刻冻结总耗时', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.tick(2_000)
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
        triggerTurn: true,
    })
    h.tick(5_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 3s$/)

    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
})

test('多个后台任务全部结束才冻结；其他会话的任务不影响当前总耗时', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.emitEvent('subagent:async-started', {
        id: 'run-2',
        sessionId: 'session-1',
    })
    h.emitEvent('subagent:async-started', {
        id: 'other',
        sessionId: 'session-2',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
        triggerTurn: false,
    })
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 2s$/)
    h.emitEvent('subagent:async-complete', {
        id: 'run-2',
        sessionId: 'session-1',
        triggerTurn: false,
    })
    assert.match(h.updates.at(-1) ?? '', /TS: 2s$/)
    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
})

test('会话切换和关闭清理后台状态，迟到或异常事件不影响新会话', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.emit('session_shutdown')
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    assert.equal(h.updates.at(-1), undefined)

    h.setSessionId('session-2')
    h.emit('session_start')
    h.emit('agent_start')
    h.tick(1_000)
    h.emit('agent_settled')
    assert.match(h.updates.at(-1) ?? '', /TS: 1s$/)
    assert.doesNotThrow(() => h.emitEvent('subagent:async-started', null))
    assert.doesNotThrow(() => h.emitEvent('subagent:async-complete', {}))
})

test('完成事件先于父任务 settled 时，批量通知唤醒仍连续累计 TS', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.tick(1_000)
    h.emit('agent_start')
    h.tick(2_000)
    h.emit('agent_settled')
    assert.match(h.updates.at(-1) ?? '', /TS: 5s$/)
})

test('完成事件先于 settled 且未唤醒时，不丢失父任务最后的处理耗时', (t) => {
    const h = harness(t)
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(1_000)
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: 'session-1',
    })
    h.tick(2_000)
    h.emit('agent_settled')
    h.tick(5_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 3s$/)
    const count = h.updates.length
    h.tick(5_000)
    assert.equal(h.updates.length, count)
})

test('后台事件用会话文件路径标识时也能继续计时', (t) => {
    const h = harness(t)
    h.setSessionFile('/tmp/session.jsonl')
    h.emit('session_start')
    h.emit('agent_start')
    h.emitEvent('subagent:async-started', {
        id: 'run-1',
        sessionId: '/tmp/session.jsonl',
    })
    h.tick(1_000)
    h.emit('agent_settled')
    h.tick(1_000)
    assert.match(h.updates.at(-1) ?? '', /TS: 2s$/)
    h.emitEvent('subagent:async-complete', {
        id: 'run-1',
        sessionId: '/tmp/session.jsonl',
        triggerTurn: false,
    })
    assert.match(h.updates.at(-1) ?? '', /TS: 2s$/)
})
