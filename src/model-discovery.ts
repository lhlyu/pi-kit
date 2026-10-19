import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
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
import Value from 'typebox/value'
import {
    builtinProviderIds,
    MAX_MODELS,
    modelId,
    matchModels,
    parseModelList,
} from './model-catalog.ts'

const MAX_BYTES = 2 * 1024 * 1024
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
    version: Type.Literal(1),
    fingerprint: Type.String(),
    ids: Type.Array(modelId, { minItems: 1, maxItems: MAX_MODELS }),
})

export interface DiscoveryOptions {
    agentDir: string
    request?: typeof fetch
    timeoutMs?: number
    warn?: (message: string) => void
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

async function fetchModels(
    url: string,
    headers: Headers,
    request: typeof fetch,
    signal: AbortSignal,
): Promise<string[]> {
    const response = await request(url, { headers, signal, redirect: 'error' })
    if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {})
        throw new Error('模型发现 HTTP 响应无效')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.length
            if (length > MAX_BYTES) throw new Error('模型列表过大')
            chunks.push(value)
        }
        signal.throwIfAborted()
        return parseModelList(
            JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks),
                ),
            ) as unknown,
        )
    } finally {
        // 不等待服务端清理完成，避免异常响应的 cancel 拖住启动。
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
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

async function readCache(
    path: string,
    fingerprint: string,
): Promise<string[] | undefined> {
    try {
        if ((await stat(path)).size > MAX_BYTES) return undefined
        const value = Value.Parse(
            cacheSchema,
            JSON.parse(await readFile(path, 'utf8')) as unknown,
        )
        if (value.fingerprint !== fingerprint) return undefined
        return parseModelList({ data: value.ids.map((id) => ({ id })) })
    } catch {
        return undefined
    }
}

async function writeCache(
    path: string,
    fingerprint: string,
    ids: string[],
    dir: string,
): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(
        path,
        JSON.stringify({
            version: 1,
            fingerprint,
            ids,
        }),
        { mode: 0o600 },
    )
}

/** 仅在异步工厂调用；网络发现不接入 /model，不改写原生配置或认证。 */
export async function discoverProviders(
    pi: ExtensionAPI,
    options: DiscoveryOptions,
): Promise<void> {
    const warn =
        options.warn ??
        ((message: string) => process.stderr.write(`[pi-kit] ${message}\n`))
    let entries: [string, unknown][]
    try {
        const root = Value.Parse(
            rootSchema,
            parseModelsConfig(
                await readFile(join(options.agentDir, 'models.json'), 'utf8'),
            ),
        )
        entries = Object.entries(root.providers).filter(([, raw]) =>
            Value.Check(enabledSchema, raw),
        )
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            warn('无法读取 models.json，跳过模型发现')
        return
    }
    if (!entries.length) return
    // 隔离的原生认证 Runtime：不联网加载内置目录、不重读整份模型配置。
    // 逐 Provider 注册静态认证配置，使一个坏配置不会影响其他 Provider 的发现。
    const authPath = join(options.agentDir, 'auth.json')
    // 在单 Provider 的容错边界内按需初始化，失败时仍可使用缓存。
    let authRuntime: Promise<ModelRuntime> | undefined
    const reserved = new Set<string>(builtinProviderIds)
    const cacheDir = join(options.agentDir, 'pi-kit', 'cache', 'providers')
    await Promise.allSettled(
        entries.map(async ([name, raw]) => {
            const label = name.slice(0, 80).replace(/[^a-zA-Z0-9_.-]/g, '?')
            try {
                if (
                    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ||
                    reserved.has(name)
                )
                    throw new Error('Provider 名称无效或冲突')
                const config = Value.Parse(configSchema, raw)
                const modelsUrl = modelsUrlFor(config)
                const fingerprint = fingerprintFor(config, modelsUrl)
                const path = join(
                    cacheDir,
                    `${createHash('sha256').update(name).digest('hex')}.json`,
                )
                const registration = registrationFor(config)
                let ids = await readCache(path, fingerprint)
                try {
                    // models.json 中的同步鉴权命令不可取消，发现阶段跳过此类配置。
                    if (
                        [
                            config.apiKey,
                            ...Object.values(config.headers ?? {}),
                        ].some((v) => v?.startsWith('!'))
                    )
                        throw new Error('发现不执行鉴权命令')
                    const signal = AbortSignal.timeout(
                        options.timeoutMs ?? 5_000,
                    )
                    const runtime = await (authRuntime ??= ModelRuntime.create({
                        modelsPath: null,
                        refreshOnCreate: false,
                        // 原生文件 Store 的读操作会创建空 auth.json；不存在时使用内存 Store。
                        ...(existsSync(authPath)
                            ? { authPath }
                            : { credentials: new InMemoryCredentialStore() }),
                    }))
                    runtime.registerProvider(name, registration)
                    const auth = await runtime.getAuth(name, { signal })
                    if (!auth) throw new Error('原生认证不可用')
                    ids = await fetchModels(
                        modelsUrl,
                        discoveryHeaders(config, auth.auth),
                        options.request ?? fetch,
                        signal,
                    )
                    try {
                        await writeCache(path, fingerprint, ids, cacheDir)
                    } catch {
                        warn(`${label}：缓存写入失败，本次模型仍可用`)
                    }
                } catch {
                    warn(
                        `${label}：模型发现失败${ids ? '，使用上次成功缓存' : '，无缓存，跳过'}`,
                    )
                }
                if (!ids) return
                registration.models = matchModels(
                    ids,
                    undefined,
                    config.api,
                    config.compat as Model<Api>['compat'],
                )
                pi.registerProvider(name, registration)
            } catch {
                warn(`${label}：配置或注册失败，跳过模型发现`)
            }
        }),
    )
}
