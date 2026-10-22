import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
    ExtensionAPI,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import { discoverProviders } from '../src/model-discovery.ts'

const provider = {
    baseUrl: 'https://relay.example/v1',
    api: 'openai-completions',
    apiKey: 'configured-key',
    discoverModels: true,
}
const response = (ids: string[]) =>
    Response.json({ data: ids.map((id) => ({ id })) })

async function harness(
    t: TestContext,
    options: { offline?: boolean; apiKey?: string | null } = {},
) {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-kit-native-refresh-'))
    t.after(() => rm(agentDir, { recursive: true, force: true }))
    await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
            providers: {
                relay: {
                    ...provider,
                    apiKey:
                        options.apiKey === null
                            ? undefined
                            : (options.apiKey ?? provider.apiKey),
                },
            },
        }),
    )
    let ids = ['old', 'retained']
    let failure = false
    let requests = 0
    let key: string | null = null
    let registration: ProviderConfig | undefined
    let runtime: ModelRuntime | undefined
    await discoverProviders(
        {
            registerProvider(_name: string, config: ProviderConfig) {
                registration = config
            },
        } as ExtensionAPI,
        {
            agentDir,
            offline: options.offline ?? false,
            warn() {},
            getAuth: async (name, signal) =>
                (await runtime!.getAuth(name, { signal }))?.auth,
            request: async (_url, init) => {
                requests++
                key = new Headers(init?.headers).get('authorization')
                if (failure) throw new Error('secret-response')
                return response(ids)
            },
        },
    )
    assert.ok(registration?.refreshModels)
    runtime = await ModelRuntime.create({
        modelsPath: join(agentDir, 'models.json'),
        credentials: new InMemoryCredentialStore(),
        refreshOnCreate: false,
    })
    runtime.registerProvider('relay', registration)
    await runtime.refresh({ providers: ['relay'], allowNetwork: false })
    return {
        agentDir,
        runtime,
        registration,
        setIds(value: string[]) {
            ids = value
        },
        fail() {
            failure = true
        },
        requests: () => requests,
        key: () => key,
        ids: () => runtime!.getModels('relay').map((model) => model.id),
        refresh: (force = false) =>
            runtime!.refresh({
                providers: ['relay'],
                allowNetwork: true,
                force,
            }),
    }
}

test('原生刷新遵循 TTL 和 force，成功删除旧模型，失败保留最近目录并返回安全错误', async (t) => {
    const h = await harness(t)
    assert.equal(h.requests(), 1)
    await h.refresh()
    assert.equal(h.requests(), 1)
    h.setIds(['retained'])
    const refreshed = await h.refresh(true)
    assert.equal(refreshed.errors.size, 0)
    assert.equal(h.requests(), 2)
    assert.deepEqual(h.ids(), ['retained'])
    h.fail()
    const failed = await h.refresh(true)
    assert.equal(failed.errors.size, 1)
    assert.match(failed.errors.get('relay')!.message, /保留上次成功目录/)
    assert.ok(!failed.errors.get('relay')!.message.includes('secret'))
    assert.deepEqual(h.ids(), ['retained'])
    await h.runtime.refresh({ providers: ['relay'], allowNetwork: false })
    assert.deepEqual(h.ids(), ['retained'])
})

test('启动无认证无目录，原生 /login 和运行时密钥生效后可直接刷新，无需 reload', async (t) => {
    const h = await harness(t, { apiKey: null })
    assert.deepEqual(h.ids(), [])
    assert.equal(h.requests(), 0)
    await h.runtime.login('relay', 'api_key', {
        prompt: async () => 'login-key',
        notify() {},
    })
    assert.equal((await h.refresh()).errors.size, 0)
    assert.equal(h.key(), 'Bearer login-key')
    assert.deepEqual(h.ids(), ['old', 'retained'])
    await h.runtime.setRuntimeApiKey('relay', 'runtime-key')
    await h.refresh(true)
    assert.equal(h.key(), 'Bearer runtime-key')
})

test('离线模式即使被原生 force 刷新也不发出请求', async (t) => {
    const h = await harness(t, { offline: true })
    await h.refresh(true)
    assert.equal(h.requests(), 0)
    assert.deepEqual(h.ids(), [])
})

test('原生取消传给请求，忽略取消而迟到的响应不更新目录或缓存', async (t) => {
    const h = await harness(t)
    const dir = join(h.agentDir, 'pi-kit/cache/providers')
    const path = join(dir, (await readdir(dir))[0]!)
    const before = await readFile(path, 'utf8')
    let resolveResponse!: (value: Response) => void
    let started!: () => void
    let requestSignal: AbortSignal | undefined
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    // 刷新闭包按需读取全局 fetch；原生取消必须传递到网络层。
    // 本用例单独注册一个使用默认 fetch 的刷新器。
    await discoverProviders(
        {
            registerProvider(name: string, config: ProviderConfig) {
                h.runtime.registerProvider(name, config)
            },
        } as ExtensionAPI,
        { agentDir: h.agentDir, offline: false, warn() {} },
    )
    await h.runtime.refresh({ providers: ['relay'], allowNetwork: false })
    t.mock.method(
        globalThis,
        'fetch',
        async (_url: unknown, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            started()
            return new Promise<Response>((resolve) => {
                resolveResponse = resolve
            })
        },
    )
    const controller = new AbortController()
    const pending = h.runtime.refresh({
        providers: ['relay'],
        allowNetwork: true,
        force: true,
        signal: controller.signal,
    })
    await ready
    controller.abort()
    assert.equal((await pending).aborted, true)
    assert.equal(requestSignal?.aborted, true)
    resolveResponse(response(['late']))
    // 让被取消请求的后续微任务完成，确认没有迟到写入。
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(h.ids(), ['old', 'retained'])
    assert.equal(await readFile(path, 'utf8'), before)
})
