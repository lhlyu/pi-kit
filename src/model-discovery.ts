import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
    ExtensionAPI,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import type { Model, Api, ModelAuth } from '@earendil-works/pi-ai'
import { parse } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import writeFileAtomic from 'write-file-atomic'
import Type from 'typebox'
import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import {
    MAX_MODELS,
    matchModels,
    modelId,
    parseModelList,
    parseModelPage,
} from './model-catalog.ts'
import type { ModelPage } from './model-catalog.ts'
import type { BuiltinCatalog } from './builtin-catalog.ts'

const MAX_PAGE_BYTES = 2 * 1024 * 1024
// 完整目录可能跨多页，缓存上限需覆盖 MAX_MODELS 个不超 512 字符的 ID。
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_PAGES = 20
const DEFAULT_CACHE_TTL_MINUTES = 5
const httpUrl = Type.Refine(
    Type.String({ minLength: 1 }),
    (value) => {
        const url = URL.parse(value)
        return (
            url !== null &&
            value === value.trim() &&
            !/[\p{Cc}\p{Cf}]/u.test(value) &&
            (url.protocol === 'https:' || url.protocol === 'http:') &&
            !url.username &&
            !url.password &&
            !url.hash
        )
    },
    () => 'URL 无效',
)
const configSchema = Type.Object({
    baseUrl: httpUrl,
    modelsUrl: Type.Optional(httpUrl),
    api: Type.Union([
        Type.Literal('openai-completions'),
        Type.Literal('openai-responses'),
        Type.Literal('anthropic-messages'),
    ]),
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    authHeader: Type.Optional(Type.Boolean()),
    cacheTtlMinutes: Type.Optional(
        Type.Number({ minimum: 0, maximum: 10_080 }),
    ),
    // 具体协议字段由 Pi 的 models.json schema 校验，不在扩展里复制一份规则。
    compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    // 不能让静态列表叠加回已删除的模型，也不接管订阅 OAuth。
    models: Type.Optional(Type.Never()),
    oauth: Type.Optional(Type.Never()),
})
type DiscoveryConfig = Type.Static<typeof configSchema>
const rootSchema = Type.Object({
    providers: Type.Record(Type.String(), Type.Unknown()),
})
const enabledSchema = Type.Object({ discoverModels: Type.Literal(true) })
const cacheSchema = Type.Object({
    version: Type.Literal(2),
    fingerprint: Type.String(),
    checkedAt: Type.Number({ minimum: 0 }),
    ids: Type.Array(modelId, { minItems: 1, maxItems: MAX_MODELS }),
})

function parseSchema<T>(schema: TSchema, value: unknown): T {
    if (Value.Check(schema, value)) return value as T
    // TypeBox 的 Parse 只给出 "Parse"；用错误路径生成可读的 debug 细节。
    const errors: string[] = []
    for (const error of Value.Errors(schema, value)) {
        errors.push(`${error.instancePath || '/'} ${error.message}`)
        if (errors.length === 3) break
    }
    throw new Error(errors.join('；') || '配置格式无效')
}

export interface DiscoveryOptions {
    agentDir: string
    request?: typeof fetch
    timeoutMs?: number
    authTimeoutMs?: number
    offline?: boolean
    cacheTtlMs?: number | undefined
    now?: () => number
    debug?: boolean
    warn?: (message: string) => void
    // 会话启动后复用宿主认证，确保 /login、/logout 和运行时密钥立即生效。
    getAuth?: (
        name: string,
        signal: AbortSignal,
    ) => Promise<ModelAuth | undefined>
}

export function parseModelsConfig(content: string): unknown {
    const errors: ParseError[] = []
    const result: unknown = parse(content.replace(/^\uFEFF/, ''), errors, {
        allowTrailingComma: false,
    })
    // jsonc-parser 默认容错；有任何语法错误都不能接受恢复出的部分配置。
    if (errors.length) throw new Error('models.json 语法无效')
    return result
}

function registrationFor(config: DiscoveryConfig): ProviderConfig {
    return {
        baseUrl: config.baseUrl,
        api: config.api,
        headers: config.headers ?? {},
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.authHeader !== undefined
            ? { authHeader: config.authHeader }
            : {}),
    }
}

function modelsUrlFor(config: DiscoveryConfig): string {
    if (config.modelsUrl) return config.modelsUrl
    const url = new URL(config.baseUrl)
    // 带查询参数的聊天 URL 不能靠字符串拼接推导发现 URL。
    if (url.search) throw new Error('baseUrl 带查询参数时需要指定 modelsUrl')
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
    return url.href
}

function discoveryHeaders(config: DiscoveryConfig, auth: ModelAuth): Headers {
    const headers = new Headers({ accept: 'application/json' })
    if (config.api === 'anthropic-messages')
        headers.set('anthropic-version', '2023-06-01')
    if (auth.apiKey !== undefined) {
        const name =
            config.api === 'anthropic-messages' ? 'x-api-key' : 'authorization'
        headers.set(
            name,
            name === 'authorization' ? `Bearer ${auth.apiKey}` : auth.apiKey,
        )
    }
    // 原生接口已经解析 stored credentials、provider env 与显式 headers。
    for (const [name, value] of Object.entries(auth.headers ?? {})) {
        if (value === null) headers.delete(name)
        else headers.set(name, value)
    }
    return headers
}

async function readResponseBody(
    response: Response,
    signal: AbortSignal,
): Promise<unknown> {
    if (signal.aborted) {
        void response.body?.cancel().catch(() => {})
        signal.throwIfAborted()
    }
    if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw new Error('模型发现 HTTP 响应无效')
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
        void response.body.cancel().catch(() => {})
        throw new Error('模型列表过大')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.length
            if (length > MAX_PAGE_BYTES) throw new Error('模型列表过大')
            chunks.push(value)
        }
        signal.throwIfAborted()
        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
            ),
        ) as unknown
    } finally {
        // 不等待服务端清理完成，避免异常响应的 cancel 拖住启动。
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

function nextUrl(
    current: string,
    next: NonNullable<ModelPage['next']>,
): string {
    const base = new URL(current)
    if ('url' in next) {
        const url = new URL(next.url, base)
        // 鉴权头只发给配置的目录地址，禁止被分页链接带到其他源。
        if (url.origin !== base.origin) throw new Error('模型分页地址跨域')
        if (url.username || url.password) throw new Error('模型分页地址无效')
        return url.href
    }
    const url = new URL(current)
    url.searchParams.set(next.param, next.token)
    return url.href
}

async function fetchModels(
    url: string,
    headers: Headers,
    request: typeof fetch,
    signal: AbortSignal,
    nonChatIds: ReadonlySet<string>,
): Promise<string[]> {
    const ids = new Set<string>()
    let current = url
    for (let page = 0; page < MAX_PAGES; page++) {
        const response = await request(current, {
            headers,
            signal,
            redirect: 'error',
        })
        const parsed = parseModelPage(
            await readResponseBody(response, signal),
            nonChatIds,
        )
        for (const id of parsed.ids) ids.add(id)
        if (ids.size > MAX_MODELS) throw new Error('模型数量超过上限')
        if (!parsed.next) {
            if (!ids.size) throw new Error('没有可用聊天模型，保留上次成功缓存')
            return [...ids].sort()
        }
        current = nextUrl(current, parsed.next)
    }
    throw new Error('模型分页过多')
}

function fingerprintFor(config: DiscoveryConfig, modelsUrl: string): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                baseUrl: config.baseUrl,
                modelsUrl,
                api: config.api,
                apiKey: config.apiKey,
                authHeader: config.authHeader ?? false,
                headers: [...new Headers(config.headers).entries()],
            }),
        )
        .digest('hex')
}

function cacheFileFor(name: string): string {
    return `${createHash('sha256').update(name).digest('hex')}.json`
}

async function readCache(
    path: string,
    fingerprint: string,
): Promise<{ ids: string[]; checkedAt: number } | undefined> {
    try {
        if ((await stat(path)).size > MAX_CACHE_BYTES) return undefined
        const value = Value.Parse(
            cacheSchema,
            JSON.parse(await readFile(path, 'utf8')) as unknown,
        )
        if (value.fingerprint !== fingerprint) return undefined
        return {
            ids: parseModelList({ data: value.ids.map((id) => ({ id })) }),
            checkedAt: value.checkedAt,
        }
    } catch {
        return undefined
    }
}

async function writeCache(
    path: string,
    fingerprint: string,
    checkedAt: number,
    ids: string[],
    dir: string,
): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(
        path,
        JSON.stringify({
            version: 2,
            fingerprint,
            checkedAt,
            ids,
        }),
        { mode: 0o600 },
    )
}

/** 删除已移除或改名的 Provider 缓存，避免 Pi 用户目录无限增长。 */
async function cleanupCache(
    dir: string,
    keep: ReadonlySet<string>,
): Promise<void> {
    try {
        for (const name of await readdir(dir)) {
            if (!name.endsWith('.json') || keep.has(name)) continue
            try {
                await rm(join(dir, name), { force: true })
            } catch {
                // 单个文件失败不应阻止清理其他缓存。
            }
        }
    } catch {
        // 缓存清理是尽力而为，不能影响发现。
    }
}

function describeError(error: unknown): string {
    const message =
        error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
    return message.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200)
}

function isLoopbackHost(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname.endsWith('.localhost')
    )
}

/** 工厂提供启动目录；后续刷新交给 Pi 的 /model 生命周期，不改写原生配置或认证。 */
export async function discoverProviders(
    pi: ExtensionAPI,
    options: DiscoveryOptions,
): Promise<void> {
    const debug = options.debug ?? process.env.PI_KIT_DEBUG !== undefined
    const warn =
        options.warn ??
        ((message: string) => {
            try {
                process.stderr.write(`[pi-kit] ${message}\n`)
            } catch {
                // stderr 不可用时不影响发现。
            }
        })
    const warnFailure = (
        label: string,
        message: string,
        error?: unknown,
    ): void => {
        warn(
            `${label}：${message}${debug && error !== undefined ? `（${describeError(error)}）` : ''}`,
        )
    }

    let entries: [string, unknown][]
    let providerNames: string[] = []
    try {
        const root = parseSchema<{ providers: Record<string, unknown> }>(
            rootSchema,
            parseModelsConfig(
                await readFile(join(options.agentDir, 'models.json'), 'utf8'),
            ),
        )
        const providers = Object.entries(root.providers)
        providerNames = providers.map(([name]) => name)
        entries = providers.filter(([, raw]) => Value.Check(enabledSchema, raw))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            warnFailure('读取 models.json', '跳过模型发现', error)
        return
    }

    const cacheDir = join(options.agentDir, 'pi-kit', 'cache', 'providers')
    // 暂时关闭 discoverModels 时保留缓存，只在 Provider 被删除或改名后清理。
    const cacheFiles = new Set(providerNames.map(cacheFileFor))
    await cleanupCache(cacheDir, cacheFiles)
    if (!entries.length) return

    // 内置目录只在启用发现时加载，纯状态栏会话不承担 providers/all 的开销。
    let catalog: BuiltinCatalog
    try {
        const { loadBuiltinCatalog } = await import('./builtin-catalog.ts')
        catalog = loadBuiltinCatalog()
    } catch (error) {
        warnFailure('加载内置模型目录', '跳过模型发现', error)
        return
    }
    // 与宿主的 PI_OFFLINE 语义一致：只认 1/true/yes，避免 PI_OFFLINE=0 反而断网。
    const offlineFlag = process.env.PI_OFFLINE?.toLowerCase()
    const offline =
        options.offline ??
        (offlineFlag === '1' || offlineFlag === 'true' || offlineFlag === 'yes')
    const now = options.now ?? Date.now
    const timeoutMs = options.timeoutMs ?? 5_000
    const authTimeoutMs = options.authTimeoutMs ?? Math.min(2_000, timeoutMs)
    // 隔离的原生认证 Runtime：不联网加载内置目录、不重读整份模型配置。
    // 逐 Provider 注册静态认证配置，使一个坏配置不会影响其他 Provider 的发现。
    const authPath = join(options.agentDir, 'auth.json')
    // 在单 Provider 的容错边界内按需初始化，失败时仍可使用缓存。
    let authRuntime: Promise<ModelRuntime> | undefined
    const reserved = new Set(catalog.providerIds)

    await Promise.allSettled(
        entries.map(async ([name, raw]) => {
            const label = name.slice(0, 80).replace(/[^a-zA-Z0-9_.-]/g, '?')
            try {
                if (
                    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ||
                    reserved.has(name)
                )
                    throw new Error('Provider 名称无效或冲突')
                const config = parseSchema<DiscoveryConfig>(configSchema, raw)
                // 原生 /model 会先解析认证；拒绝不可取消的同步命令，不能等进入刷新回调才检查。
                if (
                    [
                        config.apiKey,
                        ...Object.values(config.headers ?? {}),
                    ].some((value) => value?.startsWith('!'))
                )
                    throw new Error('发现不执行鉴权命令')
                const modelsUrl = modelsUrlFor(config)
                const fingerprint = fingerprintFor(config, modelsUrl)
                const path = join(cacheDir, cacheFileFor(name))
                const registration = registrationFor(config)
                const cached = await readCache(path, fingerprint)
                const cacheTtlMs =
                    options.cacheTtlMs ??
                    (config.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MINUTES) *
                        60_000
                let ids = cached?.ids
                let checkedAt = cached?.checkedAt
                const models = () =>
                    matchModels(
                        ids ?? [],
                        catalog.chat,
                        config.api,
                        config.compat as Model<Api>['compat'],
                        catalog.nonChatIds,
                    )
                const refresh = async (
                    allowNetwork: boolean,
                    force = false,
                    signal = new AbortController().signal,
                    getAuth?: DiscoveryOptions['getAuth'],
                ) => {
                    signal.throwIfAborted()
                    const age =
                        checkedAt === undefined ? Infinity : now() - checkedAt
                    if (
                        offline ||
                        !allowNetwork ||
                        (!force && age >= 0 && age < cacheTtlMs)
                    )
                        return models()

                    const authSignal = AbortSignal.any([
                        signal,
                        AbortSignal.timeout(authTimeoutMs),
                    ])
                    let auth: ModelAuth | undefined
                    if (getAuth) {
                        auth = await getAuth(name, authSignal)
                    } else {
                        const runtime = await (authRuntime ??=
                            ModelRuntime.create({
                                modelsPath: null,
                                refreshOnCreate: false,
                                // 不因发现创建空 auth.json。
                                ...(existsSync(authPath)
                                    ? { authPath }
                                    : {
                                          credentials:
                                              new InMemoryCredentialStore(),
                                      }),
                            }))
                        runtime.registerProvider(name, registrationFor(config))
                        auth = (
                            await runtime.getAuth(name, { signal: authSignal })
                        )?.auth
                    }
                    authSignal.throwIfAborted()
                    if (!auth) throw new Error('原生认证不可用')
                    if (
                        new URL(modelsUrl).protocol === 'http:' &&
                        !isLoopbackHost(new URL(modelsUrl).hostname) &&
                        (auth.apiKey !== undefined ||
                            Object.keys(auth.headers ?? {}).some((key) =>
                                /authorization|api[-_]?key|token/i.test(key),
                            ))
                    )
                        warnFailure(
                            label,
                            '模型发现使用明文 HTTP，凭证可能被窃听',
                        )
                    const nextIds = await fetchModels(
                        modelsUrl,
                        discoveryHeaders(config, auth),
                        options.request ?? fetch,
                        AbortSignal.any([
                            signal,
                            AbortSignal.timeout(timeoutMs),
                        ]),
                        catalog.nonChatIds,
                    )
                    signal.throwIfAborted()
                    const completedAt = now()
                    try {
                        await writeCache(
                            path,
                            fingerprint,
                            completedAt,
                            nextIds,
                            cacheDir,
                        )
                    } catch (error) {
                        warnFailure(
                            label,
                            '缓存写入失败，本次模型仍可用',
                            error,
                        )
                    }
                    signal.throwIfAborted()
                    ids = nextIds
                    checkedAt = completedAt
                    return models()
                }
                try {
                    await refresh(true)
                } catch (error) {
                    warnFailure(
                        label,
                        ids
                            ? '模型发现失败，使用上次成功缓存'
                            : '模型发现失败，无缓存，稍后可通过 /model 重试',
                        error,
                    )
                }
                registration.models = models()
                registration.refreshModels = async (context) => {
                    try {
                        return await refresh(
                            context.allowNetwork,
                            context.force,
                            context.signal,
                            options.getAuth,
                        )
                    } catch {
                        // 保留已发布目录，并交由 /model 的原生 UI 报错；不泄露原始响应或凭证。
                        context.signal.throwIfAborted()
                        throw new Error('模型发现失败，保留上次成功目录')
                    }
                }
                pi.registerProvider(name, registration)
            } catch (error) {
                warnFailure(label, '配置或注册失败，跳过模型发现', error)
            }
        }),
    )
}
