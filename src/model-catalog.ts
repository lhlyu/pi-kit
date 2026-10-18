import {
    getBuiltinClassifierModels,
    getBuiltinImageModels,
    getBuiltinModels,
    getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import Type from 'typebox'
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
const listSchema = Type.Refine(
    Type.Object({
        data: Type.Array(modelSchema, {
            minItems: 1,
            maxItems: MAX_MODELS,
        }),
        error: Type.Optional(Type.Null()),
        has_more: Type.Optional(Type.Boolean()),
        next: nullableCursor,
        next_page: nullableCursor,
        next_cursor: nullableCursor,
        next_page_token: nullableCursor,
        nextPageToken: nullableCursor,
    }),
    (list) =>
        !list.has_more &&
        !list.next &&
        !list.next_page &&
        !list.next_cursor &&
        !list.next_page_token &&
        !list.nextPageToken,
    () => '模型分页不完整',
)

export const builtinProviderIds = getBuiltinProviders()
const chatCatalog: Model<Api>[] = builtinProviderIds.flatMap((id) =>
    getBuiltinModels(id),
)
const chatIds = new Set(chatCatalog.map((model) => model.id))
const nonChatIds = new Set(
    builtinProviderIds
        .flatMap((id) => [
            ...getBuiltinImageModels(id),
            ...getBuiltinClassifierModels(id),
        ])
        .map((model) => model.id)
        .filter((id) => !chatIds.has(id)),
)
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
const openaiNonChat =
    /^(?:openai\/)?(?:text-embedding-|text-similarity-|text-search-|whisper(?:-|$)|tts-|gpt-image-|dall-e-|omni-moderation-|text-moderation-|gpt-4o(?:-mini)?-(?:transcribe|tts)|gpt-3\.5-turbo-instruct(?:-|$))/

function isChatId(id: string): boolean {
    return !nonChatIds.has(id) && !openaiNonChat.test(id)
}

export function parseModelList(value: unknown): string[] {
    const { data } = Value.Parse(listSchema, value)
    const ids = data
        .filter((model) => {
            if (
                !isChatId(model.id) ||
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
    if (!ids.length) throw new Error('没有可用聊天模型，保留上次成功缓存')
    return [...new Set(ids)].sort()
}

export function matchModels(
    ids: string[],
    catalog: readonly Model<Api>[] = chatCatalog,
    api: string = 'openai-completions',
    compat?: Model<Api>['compat'],
): ProviderModelConfig[] {
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
            Number(b.api === api) - Number(a.api === api) ||
            a.provider.localeCompare(b.provider),
    )
    const byId = new Map<string, Model<Api>>()
    for (const model of candidates)
        if (!byId.has(model.id)) byId.set(model.id, model)
    return ids.filter(isChatId).map((id) => {
        const model = byId.get(id)
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
