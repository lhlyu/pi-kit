import assert from 'node:assert/strict'
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
    DefaultResourceLoader,
    ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import type {
    ExtensionAPI,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import { discoverProviders, parseModelsConfig } from '../src/model-discovery.ts'
import { matchModels, parseModelList } from '../src/model-catalog.ts'

async function harness(t: TestContext) {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-kit-discovery-'))
    t.after(() =>
        rm(agentDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 10,
        }),
    )
    const registrations = new Map<string, ProviderConfig>()
    const warnings: string[] = []
    const pi = {
        registerProvider(name: string, config: ProviderConfig) {
            registrations.set(name, config)
        },
    } as ExtensionAPI
    const config = async (providers: Record<string, unknown>) => {
        await writeFile(
            join(agentDir, 'models.json'),
            JSON.stringify({ providers }),
        )
    }
    return {
        agentDir,
        registrations,
        warnings,
        pi,
        config,
        async load(
            request: typeof fetch,
            timeoutMs = 100,
            options: {
                cacheTtlMs?: number | undefined
                offline?: boolean
                now?: () => number
                debug?: boolean
            } = {},
        ) {
            registrations.clear()
            warnings.length = 0
            // 模拟请求永不完成时，Node 的 AbortSignal.timeout 不会单独保活事件循环；
            // 在测试里保留一个句柄，让超时回调有机会执行。
            const keepAlive = setTimeout(() => {}, timeoutMs + 100)
            try {
                await discoverProviders(pi, {
                    agentDir,
                    request,
                    timeoutMs,
                    // 测试默认强制刷新，缓存新鲜度由专门用例覆盖。
                    cacheTtlMs: 0,
                    warn: (message) => warnings.push(message),
                    ...options,
                })
            } finally {
                clearTimeout(keepAlive)
            }
        },
        async cache() {
            const dir = join(agentDir, 'pi-kit/cache/providers')
            return Promise.all(
                (await readdir(dir))
                    .filter((name) => name.endsWith('.json'))
                    .map((name) => readFile(join(dir, name), 'utf8')),
            )
        },
    }
}

const provider = {
    baseUrl: 'https://relay.example/v1/',
    api: 'openai-completions',
    apiKey: 'private-key',
    discoverModels: true,
}
const response = (ids: string[]) =>
    Response.json({ data: ids.map((id) => ({ id })) })

function setKey(t: TestContext, value: string) {
    const old = process.env.PI_KIT_TEST_KEY
    process.env.PI_KIT_TEST_KEY = value
    t.after(() => {
        if (old === undefined) delete process.env.PI_KIT_TEST_KEY
        else process.env.PI_KIT_TEST_KEY = old
    })
}

test('沿用 models.json 注释、BOM 与字符串转义，不改变内容', () => {
    assert.deepEqual(
        parseModelsConfig(
            '\uFEFF{ /* comment */ "url": "https://a/*b*/", // comment\n "key": "a\\\"b" }',
        ),
        { url: 'https://a/*b*/', key: 'a"b' },
    )
    assert.throws(() => parseModelsConfig('{ /* missing'))
})

test('发现鉴权复用原生环境插值与转义，不自行解析或执行命令', async (t) => {
    const h = await harness(t)
    setKey(t, 'secret')
    await h.config({
        valid: {
            ...provider,
            apiKey: '$PI_KIT_TEST_KEY',
            headers: {
                'x-interpolation': 'Bearer ${PI_KIT_TEST_KEY}',
                'x-escaped': '$$KEY-$!literal',
                'x-invalid-reference': '${invalid-$PI_KIT_TEST_KEY}',
            },
        },
        missing: { ...provider, apiKey: '$PI_KIT_TEST_UNSET_123456' },
        command: { ...provider, apiKey: '!echo secret' },
    })
    let requests = 0
    await h.load(async (_url, options) => {
        requests++
        const headers = new Headers(options?.headers)
        assert.equal(headers.get('authorization'), 'Bearer secret')
        assert.equal(headers.get('x-interpolation'), 'Bearer secret')
        assert.equal(headers.get('x-escaped'), '$KEY-!literal')
        assert.equal(
            headers.get('x-invalid-reference'),
            '${invalid-$PI_KIT_TEST_KEY}',
        )
        return response(['model'])
    })
    assert.equal(requests, 1)
    assert.equal(h.warnings.length, 2)
})

test('默认拼接 /models，modelsUrl 为完整地址；各 Provider 鉴权独立', async (t) => {
    const h = await harness(t)
    await h.config({
        a: provider,
        b: {
            ...provider,
            baseUrl: 'https://b.example',
            modelsUrl: 'https://catalog.example/list',
            api: 'anthropic-messages',
            apiKey: '$PI_KIT_TEST_KEY',
        },
    })
    setKey(t, 'anthropic-key')
    const requests: string[] = []
    await h.load(async (url, options) => {
        requests.push(String(url))
        assert.equal(options?.redirect, 'error')
        assert.ok(options?.signal)
        const headers = new Headers(options?.headers)
        if (String(url).includes('catalog')) {
            assert.equal(headers.get('x-api-key'), 'anthropic-key')
            assert.equal(headers.get('anthropic-version'), '2023-06-01')
            assert.equal(headers.get('authorization'), null)
        } else assert.equal(headers.get('authorization'), 'Bearer private-key')
        return response(['unknown-chat'])
    })
    assert.deepEqual(requests.sort(), [
        'https://catalog.example/list',
        'https://relay.example/v1/models',
    ])
    assert.equal(h.registrations.size, 2)
    assert.equal(h.warnings.length, 0)
    for (const config of h.registrations.values()) {
        assert.equal(typeof config.refreshModels, 'function')
        assert.equal(config.oauth, undefined)
    }
    assert.ok(
        (await h.cache()).every(
            (cache) =>
                !cache.includes('private-key') &&
                !cache.includes('anthropic-key'),
        ),
    )
})

test('空或省略 headers 均注册为空对象，非字符串值仍被拒绝', async (t) => {
    const h = await harness(t)
    await h.config({
        empty: { ...provider, headers: {} },
        missing: { ...provider, baseUrl: 'https://missing.example' },
        invalid: { ...provider, headers: { 'x-invalid': 1 } },
    })
    await h.load(async () => response(['chat']))
    assert.deepEqual([...h.registrations.keys()].sort(), ['empty', 'missing'])
    for (const config of h.registrations.values())
        assert.deepEqual(config.headers, {})
    assert.equal(h.warnings.length, 1)
})

test('精确匹配内置元数据，但不继承原厂协议、端点、鉴权及兼容字段', () => {
    const official = {
        id: 'same',
        name: 'Official',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://official',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: { input: 3, output: 15, cacheRead: 1, cacheWrite: 2 },
        headers: { secret: 'secret' },
        compat: { supportsStore: true },
    } as Model<Api>
    const gateway = {
        ...official,
        provider: 'gateway',
        name: 'Gateway',
        contextWindow: 123,
    }
    const models = matchModels(
        ['same', 'new'],
        [gateway, official],
        'openai-completions',
    )
    assert.deepEqual(models[0], {
        id: 'same',
        name: 'Official',
        api: 'openai-completions',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: official.cost,
    })
    assert.deepEqual(models[1], {
        id: 'new',
        name: 'new',
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
        contextWindow: 32_768,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
})

test('仅完整有效的非空列表成功；去重，不以部分坏数据删除模型', () => {
    assert.deepEqual(
        parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }),
        ['a', 'b'],
    )
    for (const value of [
        null,
        [],
        {},
        { data: [] },
        { data: [{ id: '' }] },
        { data: [{ id: 'a' }, {}] },
        { data: [{ id: 'a' }], has_more: true },
        { data: [{ id: 'a' }], next: 'page' },
    ])
        assert.throws(() => parseModelList(value))
})

test('失败、无效响应、空列表、鉴权失败均保留缓存；成功列表才删除模型', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['a', 'b']))
    const old = await h.cache()
    for (const bad of [
        () => {
            throw new Error('secret')
        },
        () => new Response('invalid'),
        () => response([]),
        () => Response.json({ data: [{ id: 'a' }, {}] }),
        () => new Response('', { status: 401 }),
        () => Response.json({ data: [{ id: 'a' }] }, { status: 206 }),
    ]) {
        await h.load(async () => bad())
        assert.deepEqual(
            h.registrations.get('relay')?.models?.map((m) => m.id),
            ['a', 'b'],
        )
        assert.deepEqual(await h.cache(), old)
        assert.equal(h.warnings.length, 1)
        assert.match(h.warnings[0]!, /使用上次成功缓存/)
        assert.ok(!h.warnings[0]!.includes('secret'))
    }
    await h.load(async () => response(['b']))
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((m) => m.id),
        ['b'],
    )
})

test('超时独立取消，失败无缓存注册空目录待重试，不阻塞其他 Provider', async (t) => {
    const h = await harness(t)
    await h.config({
        slow: { ...provider, modelsUrl: 'https://slow.example/models' },
        good: provider,
    })
    let aborted = false
    await h.load(async (url, options) => {
        if (!String(url).includes('slow')) return response(['working'])
        return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
                'abort',
                () => {
                    aborted = true
                    reject(new Error('timeout'))
                },
                { once: true },
            )
        })
    }, 10)
    assert.ok(aborted)
    assert.deepEqual([...h.registrations.keys()].sort(), ['good', 'slow'])
    assert.deepEqual(h.registrations.get('slow')?.models, [])
    assert.match(h.warnings[0]!, /无缓存/)
})

test('超时覆盖响应体读取，不只覆盖响应头', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['cached']))
    await h.load(
        async (_url, options) =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        options?.signal?.addEventListener(
                            'abort',
                            () => controller.error(new Error('timeout')),
                            { once: true },
                        )
                    },
                }),
            ),
        10,
    )
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
})

test('坏缓存不提供模型；更改端点后不复用旧缓存；不修改配置和认证文件', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await writeFile(join(h.agentDir, 'auth.json'), '{"unchanged":true}')
    await h.load(async () => response(['old']))
    await h.config({
        relay: { ...provider, modelsUrl: 'https://new.example/models' },
    })
    const before = await readFile(join(h.agentDir, 'models.json'), 'utf8')
    await h.load(async () => {
        throw new Error('offline')
    })
    assert.deepEqual(h.registrations.get('relay')?.models, [])
    assert.equal(
        await readFile(join(h.agentDir, 'models.json'), 'utf8'),
        before,
    )
    assert.equal(
        await readFile(join(h.agentDir, 'auth.json'), 'utf8'),
        '{"unchanged":true}',
    )
    const dir = join(h.agentDir, 'pi-kit/cache/providers')
    for (const name of await readdir(dir))
        await writeFile(join(dir, name), '{broken')
    await h.config({ relay: provider })
    await h.load(async () => {
        throw new Error('offline')
    })
    assert.deepEqual(h.registrations.get('relay')?.models, [])
})

test('只处理显式开启的独立 Provider；拒绝覆盖内置、静态列表和 OAuth', async (t) => {
    const h = await harness(t)
    await h.config({
        openai: provider,
        static: { ...provider, discoverModels: false },
        bad: { ...provider, models: [] },
        oauth: { ...provider, oauth: 'radius' },
        unsupported: { ...provider, api: 'made-up' },
        good: provider,
    })
    let count = 0
    await h.load(async () => {
        count++
        return response(['model'])
    })
    assert.equal(count, 1)
    assert.deepEqual([...h.registrations.keys()], ['good'])
    assert.equal(h.warnings.length, 4)
})

test('当前官方配置接受扩展字段，原生兼容配置和 modelOverrides 仍然生效', async (t) => {
    const h = await harness(t)
    await h.config({
        relay: {
            ...provider,
            compat: { supportsStore: false },
            modelOverrides: {
                'unknown-chat': { contextWindow: 8192, reasoning: false },
            },
        },
    })
    let requests = 0
    await h.load(async () => {
        requests++
        return response(['unknown-chat'])
    })
    const runtime = await ModelRuntime.create({
        modelsPath: join(h.agentDir, 'models.json'),
        authPath: join(h.agentDir, 'auth.json'),
        refreshOnCreate: false,
    })
    assert.equal(runtime.getError(), undefined)
    runtime.registerProvider('relay', h.registrations.get('relay')!)
    const model = runtime.getModel('relay', 'unknown-chat')
    assert.equal(model?.contextWindow, 8192)
    assert.deepEqual(model?.compat, { supportsStore: false })
    assert.equal(model?.api, 'openai-completions')
    await runtime.refresh({ providers: ['relay'], allowNetwork: true })
    assert.equal(requests, 2)
    assert.equal((await runtime.getAvailable('relay')).length, 1)
})

function runCli(
    args: string[],
    agentDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
        const child = spawn(
            process.execPath,
            [
                'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
                ...args,
            ],
            {
                cwd: resolve('.'),
                env: {
                    ...process.env,
                    PI_CODING_AGENT_DIR: agentDir,
                    PI_OFFLINE: '1',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 30_000,
            },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString()
        })
        child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
        })
        child.on('error', reject)
        child.on('close', (code) => resolveResult({ code, stdout, stderr }))
    })
}

test('真实异步扩展工厂使 pi --list-models 可见；离线直接使用缓存并删除旧模型', async (t) => {
    const h = await harness(t)
    let ids = ['pi-kit-test-first', 'pi-kit-test-second']
    const requestKeys: (string | undefined)[] = []
    await h.config({ 'pi-kit-test-relay': provider })
    const request = async (
        _url: string | URL | Request,
        options?: RequestInit,
    ) => {
        requestKeys.push(
            new Headers(options?.headers).get('authorization') ?? undefined,
        )
        return response(ids)
    }
    await h.load(request)
    const args = [
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--extension',
        resolve('src/index.ts'),
        '--list-models',
        'pi-kit-test-relay',
    ]
    // runCli 设置 PI_OFFLINE=1：真实宿主应只读扩展缓存，不再请求网络。
    const first = await runCli(args, h.agentDir)
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /pi-kit-test-first/, first.stderr)
    assert.match(first.stdout, /pi-kit-test-second/)

    ids = ['pi-kit-test-second']
    await h.load(request)
    const second = await runCli(args, h.agentDir)
    assert.equal(second.code, 0, second.stderr)
    assert.ok(!second.stdout.includes('pi-kit-test-first'))
    assert.match(second.stdout, /pi-kit-test-second/)

    assert.deepEqual(requestKeys, ['Bearer private-key', 'Bearer private-key'])
})

test('原生资源 reload 重新等待异步工厂，替换注册列表并安装原生发现钩子', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    let ids = ['old', 'retained']
    let requests = 0
    const loader = new DefaultResourceLoader({
        cwd: h.agentDir,
        agentDir: h.agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
            async (pi) => {
                await discoverProviders(pi, {
                    agentDir: h.agentDir,
                    cacheTtlMs: 0,
                    request: async () => {
                        requests++
                        return response(ids)
                    },
                    warn: (message) => h.warnings.push(message),
                })
            },
        ],
    })
    await loader.reload()
    const first = loader.getExtensions()
    assert.deepEqual(first.errors, [])
    assert.deepEqual(
        first.runtime.pendingProviderRegistrations[0]?.config.models?.map(
            (model) => model.id,
        ),
        ['old', 'retained'],
    )
    assert.equal(requests, 1)
    ids = ['retained']
    await loader.reload()
    const reloaded = loader.getExtensions()
    assert.deepEqual(reloaded.errors, [])
    assert.notEqual(reloaded.runtime, first.runtime)
    assert.equal(reloaded.runtime.pendingProviderRegistrations.length, 1)
    assert.deepEqual(
        reloaded.runtime.pendingProviderRegistrations[0]?.config.models?.map(
            (model) => model.id,
        ),
        ['retained'],
    )
    assert.equal(requests, 2)
    assert.equal(
        typeof reloaded.runtime.pendingProviderRegistrations[0]?.config
            .refreshModels,
        'function',
    )
    assert.equal(reloaded.extensions[0]?.commands.size, 0)
})

test('响应过大回退缓存，缓存写入失败仍注册本次有效列表', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['cached']))
    await h.load(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
    await rm(join(h.agentDir, 'pi-kit'), { recursive: true })
    await writeFile(join(h.agentDir, 'pi-kit'), 'not a directory')
    await h.load(async () => response(['fresh']))
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'fresh')
    assert.match(h.warnings[0]!, /缓存写入失败/)
})

test('环境变量缺失仍保留缓存；当前兼容配置不固化在缓存中', async (t) => {
    const h = await harness(t)
    setKey(t, 'initial-key')
    await h.config({ relay: { ...provider, apiKey: '$PI_KIT_TEST_KEY' } })
    await h.load(async () => response(['cached']))
    delete process.env.PI_KIT_TEST_KEY
    await h.config({
        relay: {
            ...provider,
            apiKey: '$PI_KIT_TEST_KEY',
            compat: { supportsStore: false },
        },
    })
    let requests = 0
    await h.load(async () => {
        requests++
        return response(['unexpected'])
    })
    assert.equal(requests, 0)
    const model = h.registrations.get('relay')?.models?.[0]
    assert.equal(model?.id, 'cached')
    assert.ok(model && model.type !== 'image' && model.type !== 'classifier')
    assert.deepEqual(model.compat, { supportsStore: false })
})

test('认证 Runtime 初始化失败不会中断加载：各 Provider 独立回退缓存或跳过', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['cached']))
    await h.config({
        relay: provider,
        fresh: { ...provider, baseUrl: 'https://fresh.example/v1' },
    })
    const create = t.mock.method(ModelRuntime, 'create', async () => {
        throw new Error('secret: auth runtime unavailable')
    })
    await h.load(async () => assert.fail('初始化失败后不应发起请求'))
    assert.equal(create.mock.callCount(), 1)
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
    assert.deepEqual(h.registrations.get('fresh')?.models, [])
    assert.equal(h.warnings.length, 2)
    assert.ok(
        h.warnings.some((warning) => warning.includes('使用上次成功缓存')),
    )
    assert.ok(h.warnings.some((warning) => warning.includes('无缓存')))
    assert.ok(h.warnings.every((warning) => !warning.includes('secret')))
})

test('全部配置无效或使用鉴权命令时，不初始化认证 Runtime', async (t) => {
    const h = await harness(t)
    await h.config({
        invalid: { ...provider, baseUrl: 'not a URL' },
        openai: provider,
        command: { ...provider, apiKey: '!echo secret' },
    })
    const create = t.mock.method(ModelRuntime, 'create', async () =>
        assert.fail('无可发现 Provider 时不应初始化认证 Runtime'),
    )
    await h.load(async () => assert.fail('不应发起请求'))
    assert.equal(create.mock.callCount(), 0)
    assert.equal(h.registrations.size, 0)
    assert.equal(h.warnings.length, 3)
})

test('多个 Provider 共用一次延迟创建的认证 Runtime', async (t) => {
    const h = await harness(t)
    await h.config({
        a: provider,
        b: { ...provider, baseUrl: 'https://b.example/v1' },
    })
    const create = t.mock.method(ModelRuntime, 'create')
    await h.load(async () => response(['chat']))
    assert.equal(create.mock.callCount(), 1)
    assert.equal(h.registrations.size, 2)
    assert.equal(h.warnings.length, 0)
})

test('没有配置时不请求网络、不创建缓存；缺失或损坏配置安全降级', async (t) => {
    const h = await harness(t)
    let requests = 0
    const request: typeof fetch = async () => {
        requests++
        return response(['unexpected'])
    }
    await h.load(request)
    assert.equal(h.warnings.length, 0)
    await h.config({ ordinary: { ...provider, discoverModels: false } })
    await h.load(request)
    assert.equal(h.warnings.length, 0)
    assert.deepEqual(await readdir(h.agentDir), ['models.json'])
    await writeFile(join(h.agentDir, 'models.json'), '{broken')
    await h.load(request)
    assert.equal(h.warnings.length, 1)
    assert.equal(requests, 0)
})

test('发现与原生聊天都优先使用 /login 凭证，支持仅登录和 provider-scoped env', async (t) => {
    const h = await harness(t)
    setKey(t, 'ambient-key')
    const authPath = join(h.agentDir, 'auth.json')
    const authContents = JSON.stringify({
        relay: {
            type: 'api_key',
            key: '$PI_KIT_TEST_KEY',
            env: { PI_KIT_TEST_KEY: 'stored-key' },
        },
        openai: { type: 'api_key', key: 'unrelated-key' },
    })
    await writeFile(authPath, authContents)
    for (const apiKey of [
        'configured-key',
        '$MISSING_KEY_FOR_PI_KIT_123',
        undefined,
    ]) {
        await h.config({
            relay: {
                ...provider,
                apiKey,
                headers: { 'x-scoped': '$PI_KIT_TEST_KEY' },
            },
        })
        let discoveryHeaders: Headers | undefined
        await h.load(async (_url, options) => {
            discoveryHeaders = new Headers(options?.headers)
            return response(['chat'])
        })
        assert.equal(h.warnings.length, 0)
        assert.equal(
            discoveryHeaders?.get('authorization'),
            'Bearer stored-key',
        )
        assert.equal(discoveryHeaders?.get('x-scoped'), 'stored-key')
        const runtime = await ModelRuntime.create({
            modelsPath: join(h.agentDir, 'models.json'),
            authPath,
            refreshOnCreate: false,
        })
        runtime.registerProvider('relay', h.registrations.get('relay')!)
        const nativeAuth = await runtime.getAuth('relay')
        assert.equal(
            discoveryHeaders?.get('authorization'),
            `Bearer ${nativeAuth?.auth.apiKey}`,
        )
        assert.equal(await readFile(authPath, 'utf8'), authContents)
    }
    assert.ok(
        (await h.cache()).every(
            (cache) =>
                !cache.includes('stored-key') && !cache.includes('ambient-key'),
        ),
    )
})

test('无已存储凭证时不因模型发现创建 auth.json', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['chat']))
    assert.equal(h.registrations.size, 1)
    assert.ok(!(await readdir(h.agentDir)).includes('auth.json'))
})

test('异常分页、错误信封和过滤后空列表不覆盖缓存或删除模型', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['a', 'b']))
    const before = await h.cache()
    for (const invalid of [
        { data: [{ id: 'a' }], has_more: 'true' },
        { data: [{ id: 'a' }], next_cursor: 'next' },
        { data: [{ id: 'a' }], error: { message: 'failed' } },
        { data: [{ id: 'text-embedding-3-small' }] },
        { data: [{ id: 'custom-embed', type: 'embedding' }] },
    ]) {
        await h.load(async () => Response.json(invalid))
        assert.deepEqual(
            h.registrations.get('relay')?.models?.map((m) => m.id),
            ['a', 'b'],
        )
        assert.deepEqual(await h.cache(), before)
        assert.match(h.warnings[0]!, /使用上次成功缓存/)
    }
    await h.load(async () =>
        Response.json({
            data: [
                { id: 'b' },
                { id: 'text-embedding-3-small' },
                { id: 'custom-image', type: 'image' },
            ],
        }),
    )
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((m) => m.id),
        ['b'],
    )
    assert.ok(
        (await h.cache()).every(
            (cache) =>
                !cache.includes('embedding') && !cache.includes('custom-image'),
        ),
    )
})

test('同义 headers 顺序变化不误判缓存失效', async (t) => {
    const h = await harness(t)
    await h.config({
        relay: { ...provider, headers: { 'X-A': 'a', 'X-B': 'b' } },
    })
    await h.load(async () => response(['cached']))
    await h.config({
        relay: { ...provider, headers: { 'x-b': 'b', 'x-a': 'a' } },
    })
    await h.load(async () => {
        throw new Error('offline')
    })
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
})

test('拒绝含坏 UTF-8 的响应，超时后到达的列表也不落盘', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['cached']))
    const before = await h.cache()
    const invalidUtf8 = Buffer.concat([
        Buffer.from('{"data":[{"id":"'),
        Buffer.from([0xff]),
        Buffer.from('"}]}'),
    ])
    await h.load(async () => new Response(invalidUtf8))
    assert.deepEqual(await h.cache(), before)
    await h.load(async () => {
        await new Promise((done) => setTimeout(done, 30))
        return response(['late'])
    }, 10)
    assert.deepEqual(await h.cache(), before)
    assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
})

test('baseUrl 带查询参数时必须显式 modelsUrl，不拼出错误或泄露查询参数的地址', async (t) => {
    const h = await harness(t)
    await h.config({
        invalid: {
            ...provider,
            baseUrl: 'https://relay.example/chat?token=private',
        },
        good: provider,
    })
    let count = 0
    await h.load(async () => {
        count++
        return response(['chat'])
    })
    assert.equal(count, 1)
    assert.deepEqual([...h.registrations.keys()], ['good'])
    assert.ok(h.warnings.every((warning) => !warning.includes('private')))
})

test('Anthropic 的 authHeader 与原生语义一致：追加 Bearer，不移除 x-api-key', async (t) => {
    const h = await harness(t)
    await h.config({
        relay: { ...provider, api: 'anthropic-messages', authHeader: true },
    })
    let headers: Headers | undefined
    await h.load(async (_url, options) => {
        headers = new Headers(options?.headers)
        return response(['chat'])
    })
    assert.equal(h.warnings.length, 0)
    assert.equal(headers?.get('x-api-key'), 'private-key')
    assert.equal(headers?.get('authorization'), 'Bearer private-key')
})

test(
    '异常响应的清理即使不完成，也不能拖住启动',
    { timeout: 1_000 },
    async (t) => {
        const h = await harness(t)
        await h.config({ relay: provider })
        await h.load(async () => response(['cached']))
        await h.load(
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new Uint8Array(2 * 1024 * 1024 + 1),
                            )
                        },
                        cancel() {
                            return new Promise<void>(() => {})
                        },
                    }),
                ),
        )
        assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
        await h.load(
            async () =>
                new Response(
                    new ReadableStream({
                        cancel() {
                            return new Promise<void>(() => {})
                        },
                    }),
                    { status: 500 },
                ),
        )
        assert.equal(h.registrations.get('relay')?.models?.[0]?.id, 'cached')
    },
)

test('无效单个配置不影响其他 Provider 的认证与发现', async (t) => {
    const h = await harness(t)
    await h.config({
        bad: { ...provider, apiKey: 123 },
        badHeaders: { ...provider, headers: null },
        good: provider,
    })
    await h.load(async () => response(['chat']))
    assert.deepEqual([...h.registrations.keys()], ['good'])
    assert.equal(h.warnings.length, 2)
})

test('原子缓存权限受限、无残留临时文件；过大的坏缓存安全跳过', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    await h.load(async () => response(['cached']))
    const dir = join(h.agentDir, 'pi-kit/cache/providers')
    const files = await readdir(dir)
    assert.equal(files.length, 1)
    assert.ok(files[0]?.endsWith('.json'))
    const file = join(dir, files[0]!)
    if (process.platform !== 'win32') {
        assert.equal((await stat(file)).mode & 0o777, 0o600)
        assert.equal((await stat(dir)).mode & 0o777, 0o700)
    }
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1))
    await h.load(async () => {
        throw new Error('offline')
    })
    assert.deepEqual(h.registrations.get('relay')?.models, [])
    assert.match(h.warnings[0]!, /无缓存/)
})

test('缓存新鲜时直接注册，过期后才请求网络', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    let requests = 0
    await h.load(async () => {
        requests++
        return response(['cached'])
    })
    await h.load(
        async () => {
            requests++
            return response(['fresh'])
        },
        100,
        { cacheTtlMs: 60_000 },
    )
    assert.equal(requests, 1)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['cached'],
    )

    await h.load(
        async () => {
            requests++
            return response(['fresh'])
        },
        100,
        { cacheTtlMs: 60_000, now: () => Date.now() + 61 * 60_000 },
    )
    assert.equal(requests, 2)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['fresh'],
    )
})

test('缓存 TTL 可按 Provider 配置，0 表示每次刷新', async (t) => {
    const h = await harness(t)
    await h.config({
        relay: { ...provider, cacheTtlMinutes: 0 },
    })
    let requests = 0
    for (let i = 0; i < 2; i++)
        await h.load(
            async () => {
                requests++
                return response(['chat'])
            },
            100,
            { cacheTtlMs: undefined },
        )
    assert.equal(requests, 2)
})

test('离线模式有缓存直接注册，无缓存保留空目录且不请求网络', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    let requests = 0
    await h.load(async () => {
        requests++
        return response(['cached'])
    })
    await h.load(
        async () => {
            requests++
            throw new Error('offline')
        },
        100,
        { offline: true },
    )
    assert.equal(requests, 1)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['cached'],
    )
    assert.equal(h.warnings.length, 0)

    await h.config({
        relay: provider,
        fresh: { ...provider, baseUrl: 'https://fresh.example/v1' },
    })
    await h.load(
        async () => {
            requests++
            throw new Error('offline')
        },
        100,
        { offline: true },
    )
    assert.equal(requests, 1)
    assert.deepEqual([...h.registrations.keys()].sort(), ['fresh', 'relay'])
    assert.deepEqual(h.registrations.get('fresh')?.models, [])
    assert.equal(h.warnings.length, 0)
})

test('移除或改名 Provider 后清理旧缓存', async (t) => {
    const h = await harness(t)
    await h.config({
        a: provider,
        b: { ...provider, baseUrl: 'https://b.example/v1' },
    })
    await h.load(async () => response(['chat']))
    const dir = join(h.agentDir, 'pi-kit/cache/providers')
    assert.equal((await readdir(dir)).length, 2)

    await h.config({ a: provider })
    await h.load(
        async () => {
            throw new Error('offline')
        },
        100,
        { cacheTtlMs: 60_000 },
    )
    assert.equal((await readdir(dir)).length, 1)
    assert.deepEqual([...h.registrations.keys()], ['a'])
})

test('游标和同源链接自动翻页，跨源链接拒绝且不泄露鉴权', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    const urls: string[] = []
    await h.load(async (url) => {
        urls.push(String(url))
        return urls.length === 1
            ? Response.json({
                  data: [{ id: 'a' }],
                  next_cursor: 'page-2',
              })
            : Response.json({ data: [{ id: 'b' }], next_cursor: '' })
    })
    assert.equal(urls.length, 2)
    assert.match(urls[1]!, /cursor=page-2/)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['a', 'b'],
    )

    // 部分接口会在最后一页返回空 data；应保留前面已收集的模型。
    urls.length = 0
    await h.load(
        async (url) => {
            urls.push(String(url))
            return urls.length === 1
                ? Response.json({
                      data: [{ id: 'a' }],
                      has_more: true,
                      next_cursor: 'last',
                  })
                : Response.json({ data: [] })
        },
        100,
        { cacheTtlMs: 0 },
    )
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['a'],
    )

    urls.length = 0
    await h.load(
        async (url) => {
            urls.push(String(url))
            return Response.json({
                data: [{ id: 'c' }],
                next: 'https://evil.example/models?page=2',
            })
        },
        100,
        { cacheTtlMs: 0 },
    )
    assert.equal(urls.length, 1)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['a'],
    )
    assert.match(h.warnings[0]!, /使用上次成功缓存/)
})

test('Anthropic 分页按 after_id 续页，末页停止后合并全部模型', async (t) => {
    const h = await harness(t)
    await h.config({ relay: { ...provider, api: 'anthropic-messages' } })
    const urls: string[] = []
    await h.load(async (url) => {
        urls.push(String(url))
        return urls.length === 1
            ? Response.json({
                  data: [{ id: 'claude-a', type: 'model' }],
                  has_more: true,
                  first_id: 'claude-a',
                  last_id: 'claude-a',
              })
            : Response.json({
                  data: [{ id: 'claude-b', type: 'model' }],
                  has_more: false,
                  first_id: 'claude-b',
                  last_id: 'claude-b',
              })
    })
    assert.equal(urls.length, 2)
    assert.match(urls[1]!, /after_id=claude-a/)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['claude-a', 'claude-b'],
    )
    assert.deepEqual(h.warnings, [])
})

test('PI_OFFLINE 只认 1/true/yes，其他值仍允许联网刷新', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    const old = process.env.PI_OFFLINE
    t.after(() => {
        if (old === undefined) delete process.env.PI_OFFLINE
        else process.env.PI_OFFLINE = old
    })
    for (const flag of ['0', 'false', '']) {
        process.env.PI_OFFLINE = flag
        let requests = 0
        await h.load(async () => {
            requests++
            return response(['chat'])
        })
        assert.equal(requests, 1, flag)
        assert.deepEqual(
            h.registrations.get('relay')?.models?.map((model) => model.id),
            ['chat'],
        )
    }

    process.env.PI_OFFLINE = 'yes'
    let requests = 0
    await h.load(
        async () => {
            requests++
            return response(['network'])
        },
        100,
        { cacheTtlMs: 0 },
    )
    assert.equal(requests, 0)
    assert.deepEqual(
        h.registrations.get('relay')?.models?.map((model) => model.id),
        ['chat'],
    )
})

test('多页大目录写入的缓存可离线读回，不被单页上限裁掉', async (t) => {
    const h = await harness(t)
    await h.config({ relay: provider })
    const id = (page: number, index: number) =>
        `chat-${page}-${index}-${'x'.repeat(480)}`
    let requests = 0
    await h.load(async () => {
        const page = requests++
        return Response.json({
            data: Array.from({ length: 2_500 }, (_, index) => ({
                id: id(page, index),
            })),
            ...(page === 0 ? { next_cursor: '2' } : {}),
        })
    }, 30_000)
    assert.equal(requests, 2)
    const expected = h.registrations.get('relay')?.models?.length
    assert.equal(expected, 5_000)
    const cache = await h.cache()
    assert.ok((cache[0]?.length ?? 0) > 2 * 1024 * 1024)

    await h.load(
        async () => {
            throw new Error('offline')
        },
        100,
        { offline: true },
    )
    assert.equal(h.registrations.get('relay')?.models?.length, 5_000)
    assert.deepEqual(h.warnings, [])
})
