import assert from 'node:assert/strict'
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
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
        async load(request: typeof fetch, timeoutMs = 100) {
            registrations.clear()
            warnings.length = 0
            await discoverProviders(pi, {
                agentDir,
                request,
                timeoutMs,
                warn: (message) => warnings.push(message),
            })
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
        assert.equal(config.refreshModels, undefined)
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

test('超时独立取消，失败无缓存跳过，不阻塞其他 Provider', async (t) => {
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
    assert.deepEqual([...h.registrations.keys()], ['good'])
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

test('坏缓存不注册；更改端点后不复用旧缓存；不修改配置和认证文件', async (t) => {
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
    assert.equal(h.registrations.size, 0)
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
    assert.equal(h.registrations.size, 0)
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
    assert.equal(requests, 1)
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

test('真实异步扩展工厂使 pi --list-models 可见；重复加载成功删除，离线使用缓存', async (t) => {
    const h = await harness(t)
    let ids = ['pi-kit-test-first', 'pi-kit-test-second']
    let requests = 0
    let fail = false
    const requestKeys: (string | undefined)[] = []
    const server = createServer((req, res) => {
        requests++
        requestKeys.push(req.headers.authorization)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: fail ? [] : ids.map((id) => ({ id })) }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    t.after(
        () =>
            new Promise<void>((done, reject) =>
                server.close((error) => (error ? reject(error) : done())),
            ),
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await h.config({
        'pi-kit-test-relay': {
            ...provider,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
    })
    const args = [
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--extension',
        resolve('src/index.ts'),
        '--list-models',
        'pi-kit-test-relay',
    ]
    const first = await runCli(args, h.agentDir)
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /pi-kit-test-first/, first.stderr)
    assert.match(first.stdout, /pi-kit-test-second/)
    assert.equal(requests, 1)
    ids = ['pi-kit-test-second']
    await writeFile(
        join(h.agentDir, 'auth.json'),
        JSON.stringify({
            'pi-kit-test-relay': { type: 'api_key', key: 'saved-key' },
        }),
    )
    await h.config({
        'pi-kit-test-relay': {
            ...provider,
            apiKey: undefined,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
    })
    const second = await runCli(args, h.agentDir)
    assert.equal(second.code, 0, second.stderr)
    assert.ok(!second.stdout.includes('pi-kit-test-first'))
    assert.match(second.stdout, /pi-kit-test-second/)
    fail = true
    const offline = await runCli(args, h.agentDir)
    assert.equal(offline.code, 0, offline.stderr)
    assert.match(offline.stdout, /pi-kit-test-second/)
    assert.match(offline.stderr, /使用上次成功缓存/)
    assert.equal(requests, 3)
    assert.deepEqual(requestKeys, [
        'Bearer private-key',
        'Bearer saved-key',
        'Bearer saved-key',
    ])
})

test('原生资源 reload 重新等待异步工厂，替换注册列表而不安装发现钩子', async (t) => {
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
        reloaded.runtime.pendingProviderRegistrations[0]?.config.refreshModels,
        undefined,
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
    assert.equal(h.registrations.size, 0)
    assert.match(h.warnings[0]!, /无缓存/)
})
