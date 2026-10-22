import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type {
    ExtensionAPI,
    ExtensionContext,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import discoveryExtension from '../src/discovery-extension.ts'

async function harness(t: TestContext) {
    const agentDir = await mkdtemp(
        join(tmpdir(), 'pi-kit-discovery-extension-'),
    )
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    t.after(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = previous
        await rm(agentDir, { recursive: true, force: true })
    })
    await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
            providers: {
                relay: {
                    baseUrl: 'not a URL',
                    api: 'openai-completions',
                    apiKey: 'secret',
                    discoverModels: true,
                },
            },
        }),
    )
    const handlers = new Map<
        string,
        (event: unknown, ctx: ExtensionContext) => unknown
    >()
    const commands = new Map<
        string,
        {
            description?: string
            handler: (args: string, ctx: unknown) => Promise<void>
        }
    >()
    const registrations = new Map<string, ProviderConfig>()
    const pi = {
        on(
            name: string,
            handler: (event: unknown, ctx: ExtensionContext) => unknown,
        ) {
            handlers.set(name, handler)
            return () => handlers.delete(name)
        },
        registerCommand(
            name: string,
            options: {
                description?: string
                handler: (args: string, ctx: unknown) => Promise<void>
            },
        ) {
            commands.set(name, options)
        },
        registerProvider(name: string, config: ProviderConfig) {
            registrations.set(name, config)
        },
    } as unknown as ExtensionAPI
    return {
        agentDir,
        handlers,
        commands,
        registrations,
        pi,
    }
}

test('工厂阶段的发现警告在 session_start 通过 UI 通知展示', async (t) => {
    const h = await harness(t)
    await discoveryExtension(h.pi)
    const messages: string[] = []
    const handler = h.handlers.get('session_start')
    assert.ok(handler)
    handler({}, {
        hasUI: true,
        ui: {
            notify(message: string) {
                messages.push(message)
            },
        },
    } as unknown as ExtensionContext)
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /配置或注册失败/)
    assert.ok(!messages[0]!.includes('secret'))

    // 只报告一次，后续新会话不重复提示。
    handler({}, {
        hasUI: true,
        ui: {
            notify(message: string) {
                messages.push(message)
            },
        },
    } as unknown as ExtensionContext)
    assert.equal(messages.length, 1)
})

test('没有 UI 时警告写入 stderr', async (t) => {
    const h = await harness(t)
    await discoveryExtension(h.pi)
    const writes: string[] = []
    const write = t.mock.method(process.stderr, 'write', (chunk: unknown) => {
        writes.push(String(chunk))
        return true
    })
    const handler = h.handlers.get('session_start')
    assert.ok(handler)
    handler({}, {
        hasUI: false,
        ui: {},
    } as unknown as ExtensionContext)
    write.mock.restore()
    assert.equal(writes.length, 1)
    assert.match(writes[0]!, /\[pi-kit\].*配置或注册失败/)
})

test('没有 session_start 的命令在退出前输出警告', async (t) => {
    const h = await harness(t)
    await discoveryExtension(h.pi)
    const writes: string[] = []
    const write = t.mock.method(process.stderr, 'write', (chunk: unknown) => {
        writes.push(String(chunk))
        return true
    })
    const listeners = process.listeners('exit')
    const flush = listeners.at(-1)
    assert.ok(flush)
    flush(0)
    write.mock.restore()
    assert.equal(writes.length, 1)
    assert.match(writes[0]!, /\[pi-kit\].*配置或注册失败/)
    assert.equal(process.listeners('exit').includes(flush), false)
})

for (const startupFails of [false, true]) {
    test(`原生刷新使用当前会话认证（启动${startupFails ? '失败' : '成功'}）并在关闭后释放上下文`, async (t) => {
        const h = await harness(t)
        await writeFile(
            join(h.agentDir, 'models.json'),
            JSON.stringify({
                providers: {
                    relay: {
                        baseUrl: `${startupFails ? 'http' : 'https'}://relay.example/v1`,
                        api: 'openai-completions',
                        apiKey: 'configured',
                        discoverModels: true,
                    },
                },
            }),
        )
        let key: string | null = null
        let fail = startupFails
        t.mock.method(
            globalThis,
            'fetch',
            async (_url: unknown, init?: RequestInit) => {
                if (fail) throw new Error('temporary failure')
                key = new Headers(init?.headers).get('authorization')
                return Response.json({ data: [{ id: 'chat' }] })
            },
        )
        await discoveryExtension(h.pi)
        const refresh = h.registrations.get('relay')?.refreshModels
        assert.ok(refresh)
        const messages: string[] = []
        h.handlers.get('session_start')?.({}, {
            hasUI: true,
            ui: { notify: (message: string) => messages.push(message) },
            modelRegistry: {
                getProviderAuth: async () => ({
                    auth: { apiKey: 'session-key' },
                }),
            },
        } as unknown as ExtensionContext)
        fail = false
        messages.length = 0
        const context = {
            allowNetwork: true,
            force: true,
            signal: new AbortController().signal,
            publish: async () => true,
        }
        assert.equal((await refresh(context))[0]?.id, 'chat')
        assert.equal(key, 'Bearer session-key')
        assert.equal(messages.length, startupFails ? 1 : 0)
        if (startupFails) assert.match(messages[0]!, /明文 HTTP/)
        h.handlers.get('session_shutdown')?.({}, {} as ExtensionContext)
        await assert.rejects(refresh(context), /模型发现失败/)
    })
}

test('复用原生 /model，不额外注册刷新命令', async (t) => {
    const h = await harness(t)
    await discoveryExtension(h.pi)
    assert.equal(h.commands.size, 0)
    h.handlers.get('session_shutdown')?.({}, {} as ExtensionContext)
})
