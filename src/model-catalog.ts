import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import Type from 'typebox'
import type { TSchema } from 'typebox'
import Value from 'typebox/value'

export const MAX_MODELS = 10_000
const invalidModelIdChars = /[\p{Cc}\p{Cf}]/u
export const modelId = Type.Refine(
    Type.String({ minLength: 1, maxLength: 512 }),
    // TypeBox 的长度按字素簇计算，补充 UTF-16 上限，避免单个字素簇绕过 512 字符限制。
    (id) =>
        id.length <= 512 && id === id.trim() && !invalidModelIdChars.test(id),
    () => '模型 ID 无效',
)
const nullableCursor = Type.Optional(Type.Union([Type.String(), Type.Null()]))
const modelSchema = Type.Object({
    id: modelId,
    type: Type.Optional(Type.String()),
    object: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    output_modalities: Type.Optional(Type.Array(Type.String())),
    architecture: Type.Optional(
        Type.Object({
            output_modalities: Type.Optional(Type.Array(Type.String())),
        }),
    ),
})
const pageSchema = Type.Object({
    data: Type.Array(modelSchema, {
        // 允许分页接口返回没有新模型的结束页；单页路径由 parseModelList 拒绝空结果。
        minItems: 0,
        maxItems: MAX_MODELS,
    }),
    error: Type.Optional(Type.Null()),
    has_more: Type.Optional(Type.Boolean()),
    next: nullableCursor,
    next_page: nullableCursor,
    next_cursor: nullableCursor,
    next_page_token: nullableCursor,
    nextPageToken: nullableCursor,
    // Anthropic 风格：续页用 after_id=<last_id>。
    last_id: nullableCursor,
})
type ParsedPage = Type.Static<typeof pageSchema>

export interface ModelPage {
    ids: string[]
    next?:
        | { url: string }
        | {
              param: 'cursor' | 'page' | 'page_token' | 'pageToken' | 'after_id'
              token: string
          }
}

const nonChatTypes = new Set([
    'embedding',
    'embeddings',
    'rerank',
    'reranker',
    'image',
    'audio',
    'speech',
    'classifier',
    'moderation',
])
// 标准 OpenAI 模型没有类型元数据；只排除明确的非聊天产品 ID，不模糊猜测未知模型。
// 其他厂商的常见 embedding / rerank 家族也一并排除，避免它们出现在 /model 里。
const knownNonChat =
    /^(?:bge[-/]|baai\/bge|voyage[-/]|voyageai\/|jina-(?:embed|rerank)|nomic-(?:embed|ai\/nomic-embed)|mixedbread-ai\/|mxbai-embed|snowflake-arctic-embed|sentence-transformers\/|intfloat\/|text-embedding|text-similarity|text-search|embed-(?:english|multilingual)|e5-|gte-|cohere\/(?:embed|rerank)|rerank-|(?:qwen\/)?qwen3-(?:embedding|reranker)|llama-embed|nemotron-embed|whisper(?:-|$)|tts-|gpt-image-|dall-e-|omni-moderation|text-moderation|gpt-4o(?:-mini)?-(?:transcribe|tts)|gpt-3\.5-turbo-instruct(?:-|$)|stable-diffusion|stability-ai\/|black-forest-labs\/|flux[.-]|seedream|seedance|imagen|recraft|ideogram|sora(?:-|$)|veo-|kling)/i

function isChatId(id: string, nonChatIds: ReadonlySet<string>): boolean {
    if (nonChatIds.has(id)) return false
    if (knownNonChat.test(id)) return false
    // 带厂商前缀时按最后一段再判断一次，例如 openai/text-embedding-3-large。
    return !knownNonChat.test(id.split('/').at(-1) ?? id)
}

function nextPageOf(page: {
    has_more?: boolean
    next?: string | null
    next_page?: string | null
    next_cursor?: string | null
    next_page_token?: string | null
    nextPageToken?: string | null
    last_id?: string | null
}): ModelPage['next'] {
    // has_more: false 是服务端明确的结束信号，忽略可能残留的游标。
    if (page.has_more === false) return undefined

    // 空字符串与 null 一样表示没有续页；has_more 为 true 时仍拒绝不完整列表。
    const link = page.next || page.next_page
    const cursor = page.next_cursor
        ? { param: 'cursor' as const, token: page.next_cursor }
        : page.next_page_token
          ? { param: 'page_token' as const, token: page.next_page_token }
          : page.nextPageToken
            ? { param: 'pageToken' as const, token: page.nextPageToken }
            : undefined

    if (typeof link === 'string' && link.length > 0) {
        if (page.next === link) return { url: link }
        // next_page 可能是页码，也可能是相对链接；只有明显的链接才当作 URL。
        if (/^(?:https?:\/\/|\/|\.{1,2}\/|\?)/i.test(link)) return { url: link }
        return { param: 'page', token: link }
    }
    if (cursor) return cursor
    // 仅 has_more 明确为 true 时按 last_id 续页，避免服务端复述 last_id 时死循环。
    if (page.has_more === true && page.last_id)
        return { param: 'after_id', token: page.last_id }
    if (page.has_more === true) throw new Error('模型分页不完整')
    return undefined
}

function parseSchema<T>(schema: TSchema, value: unknown): T {
    if (Value.Check(schema, value)) return value as T
    const errors: string[] = []
    for (const error of Value.Errors(schema, value)) {
        errors.push(`${error.instancePath || '/'} ${error.message}`)
        if (errors.length === 3) break
    }
    throw new Error(errors.join('；') || '模型列表格式无效')
}

/** 解析一页模型目录；分页由调用方按需继续。 */
export function parseModelPage(
    value: unknown,
    nonChatIds: ReadonlySet<string> = new Set(),
): ModelPage {
    const page = parseSchema<ParsedPage>(pageSchema, value)
    const ids = page.data
        .filter((model) => {
            if (
                !isChatId(model.id, nonChatIds) ||
                [model.type, model.object, model.task].some((kind) =>
                    nonChatTypes.has(kind?.toLowerCase() ?? ''),
                )
            )
                return false
            const output =
                model.output_modalities ?? model.architecture?.output_modalities
            return output === undefined || output.includes('text')
        })
        .map((model) => model.id)
    const next = nextPageOf(page)
    return {
        ids: [...new Set(ids)].sort(),
        ...(next ? { next } : {}),
    }
}

/** 单页目录必须完整；缓存校验和调用方不会自动翻页的路径使用它。 */
export function parseModelList(
    value: unknown,
    nonChatIds: ReadonlySet<string> = new Set(),
): string[] {
    const page = parseModelPage(value, nonChatIds)
    if (page.next) throw new Error('模型分页不完整')
    if (!page.ids.length) throw new Error('没有可用聊天模型，保留上次成功缓存')
    return page.ids
}

/** 生成 ID 的归一化键：忽略大小写、厂商前缀、日期/版本后缀和点横线差异。 */
function modelKeys(id: string): string[] {
    let value = id.trim().toLowerCase()
    value = value.replace(/:.*$/, '')
    value = value.replace(/@(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/, '')
    value = value.replace(/-v[0-9]+(?:-[0-9]+)?$/, '')
    value = value.replace(/-(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/, '')
    value = value.replace(/-latest$/, '')
    const normalized = value
        .replace(/[._/\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
    const segment = value.split('/').at(-1) ?? value
    const segmentKey = segment
        .replace(/[._\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
    return normalized === segmentKey ? [normalized] : [normalized, segmentKey]
}

interface CatalogIndex {
    byId: Map<string, Model<Api>>
    alias: Map<string, Model<Api>>
}

const indexes = new WeakMap<readonly Model<Api>[], CatalogIndex>()

function catalogIndex(catalog: readonly Model<Api>[]): CatalogIndex {
    const cached = indexes.get(catalog)
    if (cached) return cached
    const native = new Set([
        'openai',
        'anthropic',
        'google',
        'mistral',
        'xai',
        'deepseek',
    ])
    const candidates = [...catalog].sort(
        (a, b) =>
            Number(native.has(b.provider)) - Number(native.has(a.provider)) ||
            a.provider.localeCompare(b.provider),
    )
    const byId = new Map<string, Model<Api>>()
    const alias = new Map<string, Model<Api>>()
    for (const model of candidates) {
        if (!byId.has(model.id)) byId.set(model.id, model)
        for (const key of modelKeys(model.id)) {
            if (!alias.has(key)) alias.set(key, model)
        }
    }
    const index = { byId, alias }
    indexes.set(catalog, index)
    return index
}

/**
 * 精确 ID 优先；其次匹配归一化后的厂商前缀、点横线和日期版本，
 * 让 relay 暴露的 `openai/gpt-5`、`claude-sonnet-4.5` 等 ID 也能沿用内置能力信息。
 */
export function matchModels(
    ids: string[],
    catalog: readonly Model<Api>[],
    api: string,
    compat?: Model<Api>['compat'],
    nonChatIds: ReadonlySet<string> = new Set(),
): ProviderModelConfig[] {
    const index = catalogIndex(catalog)
    return ids
        .filter((id) => isChatId(id, nonChatIds))
        .map((id) => {
            let model = index.byId.get(id)
            if (!model) {
                for (const key of modelKeys(id)) {
                    model = index.alias.get(key)
                    if (model) break
                }
            }
            return {
                id,
                name: model?.name ?? id,
                api,
                reasoning: model?.reasoning ?? false,
                input: [...(model?.input ?? ['text'])],
                cost: structuredClone(
                    model?.cost ?? {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                ),
                contextWindow: model?.contextWindow ?? 32_768,
                maxTokens: model?.maxTokens ?? 4_096,
                ...(compat !== undefined ? { compat } : {}),
            }
        })
}
