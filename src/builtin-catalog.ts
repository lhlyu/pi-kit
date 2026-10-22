import {
    getBuiltinClassifierModels,
    getBuiltinImageModels,
    getBuiltinModels,
    getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'
import type { Api, Model } from '@earendil-works/pi-ai'

export interface BuiltinCatalog {
    providerIds: readonly string[]
    chat: readonly Model<Api>[]
    /** 内置目录中明确属于图片、分类器等非聊天用途的模型 ID。 */
    nonChatIds: ReadonlySet<string>
}

let cached: BuiltinCatalog | undefined

/**
 * 内置目录只在真正需要模型发现时加载，避免只用状态栏的会话承担
 * `providers/all` 的模块图开销。
 */
export function loadBuiltinCatalog(): BuiltinCatalog {
    if (cached) return cached
    const providerIds = getBuiltinProviders()
    const chat = providerIds.flatMap((id) => getBuiltinModels(id))
    const chatIds = new Set(chat.map((model) => model.id))
    const nonChatIds = new Set(
        providerIds
            .flatMap((id) => [
                ...getBuiltinImageModels(id),
                ...getBuiltinClassifierModels(id),
            ])
            .map((model) => model.id)
            .filter((id) => !chatIds.has(id)),
    )
    cached = { providerIds, chat, nonChatIds }
    return cached
}
