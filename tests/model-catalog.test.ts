import assert from 'node:assert/strict'
import test from 'node:test'
import {
    parseModelList,
    parseModelPage,
    matchModels,
} from '../src/model-catalog.ts'
import { loadBuiltinCatalog } from '../src/builtin-catalog.ts'
import { parseModelsConfig } from '../src/model-discovery.ts'

const model = (id: string) => ({ id })

test('JSONC 必须完整合法，不接受库容错恢复出的部分配置或 Pi 不支持的 JSON5 语法', () => {
    for (const content of [
        '',
        '// only comment',
        '{ /* unterminated',
        '{"providers": {"a": {}}',
        '{"providers": {},}',
        "{'providers': {}}",
        '{providers: {}}',
        '{"providers": {}, "bad": NaN}',
        '{"providers": {}} trailing',
        '{"providers": {} "other": true}',
    ])
        assert.throws(() => parseModelsConfig(content), content)
    assert.deepEqual(
        parseModelsConfig('{"providers": {}} // trailing comment'),
        { providers: {} },
    )
})

test('分页字段必须类型正确，所有已知续页指示都不能当作完整成功结果', () => {
    for (const field of [
        'next',
        'next_page',
        'next_cursor',
        'next_page_token',
        'nextPageToken',
    ]) {
        for (const value of ['next-token', true, false, 1, {}, []])
            assert.throws(() =>
                parseModelList({ data: [model('chat')], [field]: value }),
            )
        for (const value of [null, '']) {
            assert.deepEqual(
                parseModelList({ data: [model('chat')], [field]: value }),
                ['chat'],
            )
            assert.throws(() =>
                parseModelPage({
                    data: [model('chat')],
                    has_more: true,
                    [field]: value,
                }),
            )
        }
    }
    for (const value of [true, 'true', 'false', 1, 0, null, {}, []])
        assert.throws(() =>
            parseModelList({ data: [model('chat')], has_more: value }),
        )
    assert.deepEqual(
        parseModelList({ data: [model('chat')], has_more: false }),
        ['chat'],
    )
})

test('HTTP 成功但响应带错误，仍然不能视为成功目录', () => {
    assert.throws(() =>
        parseModelList({ data: [model('chat')], error: { message: 'failed' } }),
    )
    assert.deepEqual(parseModelList({ data: [model('chat')], error: null }), [
        'chat',
    ])
})

test('明确的非聊天产品不会出现在聊天目录，未知模型仍保守保留', () => {
    const nonChat = [
        'text-embedding-3-small',
        'openai/text-embedding-3-large',
        'whisper-1',
        'tts-1-hd',
        'gpt-image-1',
        'dall-e-3',
        'omni-moderation-latest',
        'gpt-4o-mini-transcribe',
        'gpt-4o-mini-tts',
        'gpt-3.5-turbo-instruct',
        'typesafe/jev',
        'Qwen3-Embedding-8B',
        'Qwen/Qwen3-Reranker-8B',
        'flux.1-dev',
    ]
    const chat = ['gpt-4o', 'my-custom-model', 'embedding-expert-chat']
    const { nonChatIds } = loadBuiltinCatalog()
    assert.deepEqual(
        parseModelList({ data: [...nonChat, ...chat].map(model) }, nonChatIds),
        chat.sort(),
    )
    assert.deepEqual(
        matchModels(nonChat, [], 'openai-completions', undefined, nonChatIds),
        [],
    )
})

test('按响应中的明确类型和输出能力过滤，不仅依赖模型名称', () => {
    assert.deepEqual(
        parseModelList({
            data: [
                { id: 'custom-embed', type: 'embedding' },
                { id: 'custom-rerank', task: 'rerank' },
                { id: 'custom-image', object: 'Image' },
                { id: 'custom-audio', output_modalities: ['audio'] },
                {
                    id: 'custom-image-2',
                    architecture: { output_modalities: ['image'] },
                },
                {
                    id: 'custom-chat',
                    type: 'model',
                    object: 'model',
                    architecture: { output_modalities: ['text'] },
                },
                {
                    id: 'custom-multimodal',
                    output_modalities: ['text', 'image'],
                },
            ],
        }),
        ['custom-chat', 'custom-multimodal'],
    )
})

test('原始列表为空或过滤后没有聊天模型时都拒绝更新缓存', () => {
    for (const data of [
        [],
        [model('text-embedding-3-small')],
        [{ id: 'unknown', type: 'embedding' }],
    ])
        assert.throws(() => parseModelList({ data }))
})

test('模型 ID 中控制字符、不可见格式控制符或超长字素簇会使整份响应失效', () => {
    for (const id of [
        '\u001b[31m',
        'a\u009bb',
        'a\u202eb',
        'a\u200bb',
        ' spaced',
        'trailing ',
        'a'.repeat(513),
        'a\u0301'.repeat(300),
        '😀'.repeat(512),
    ])
        assert.throws(() =>
            parseModelList({ data: [model('good'), model(id)] }),
        )
})

test('坏类型元数据或超量响应不接受部分列表', () => {
    for (const bad of [
        { id: 'bad', type: 1 },
        { id: 'bad', architecture: null },
        { id: 'bad', output_modalities: [1] },
    ])
        assert.throws(() => parseModelList({ data: [model('good'), bad] }))
    assert.throws(() =>
        parseModelList({
            data: Array.from({ length: 10_001 }, () => model('duplicate')),
        }),
    )
})

test('relay 常见厂商前缀、点横线与日期后缀沿用内置能力', () => {
    const { chat } = loadBuiltinCatalog()
    const ids = [
        'openai/gpt-5.2',
        'anthropic/claude-sonnet-4.5',
        'google/gemini-2.5-pro',
        'claude-sonnet-4-5-20250929',
        'gemini-2.5-pro:batch',
        'unknown-vendor/model-x',
    ]
    const models = matchModels(ids, chat, 'openai-completions')
    const byId = new Map(models.map((model) => [model.id, model]))
    const chatInfo = (id: string) =>
        byId.get(id) as
            | { name: string; contextWindow: number; reasoning: boolean }
            | undefined
    for (const id of ids.slice(0, 5)) {
        assert.notEqual(chatInfo(id)?.name, id, id)
        assert.ok((chatInfo(id)?.contextWindow ?? 0) > 32_768, id)
    }
    assert.equal(chatInfo('unknown-vendor/model-x')?.contextWindow, 32_768)
    assert.equal(chatInfo('unknown-vendor/model-x')?.reasoning, false)
})

test('常见第三方 embedding / rerank 家族被过滤，聊天模型不受影响', () => {
    const { nonChatIds } = loadBuiltinCatalog()
    const chat = ['gpt-4o', 'embedding-expert-chat']
    assert.deepEqual(
        parseModelList(
            {
                data: [
                    'BAAI/bge-m3',
                    'voyage-3',
                    'jina-embeddings-v3',
                    'nomic-ai/nomic-embed-text',
                    'cohere/rerank-english-v3.0',
                    'Qwen/Qwen3-Embedding-8B',
                    'bge-reranker-v2-m3',
                    ...chat,
                ].map(model),
            },
            nonChatIds,
        ),
        chat.sort(),
    )
})

test('分页描述支持链接与游标字段', () => {
    assert.deepEqual(
        parseModelPage({ data: [model('chat')], next_cursor: 'abc' }).next,
        { param: 'cursor', token: 'abc' },
    )
    assert.deepEqual(
        parseModelPage({ data: [model('chat')], next_page_token: 'abc' }).next,
        { param: 'page_token', token: 'abc' },
    )
    assert.deepEqual(
        parseModelPage({ data: [model('chat')], nextPageToken: 'abc' }).next,
        { param: 'pageToken', token: 'abc' },
    )
    assert.deepEqual(
        parseModelPage({ data: [model('chat')], next: '/v1/models?page=2' })
            .next,
        { url: '/v1/models?page=2' },
    )
    assert.deepEqual(
        parseModelPage({
            data: [model('chat')],
            has_more: false,
            next_cursor: 'ignored',
        }).next,
        undefined,
    )
    assert.throws(() =>
        parseModelPage({ data: [model('chat')], has_more: true }),
    )
})

test('Anthropic 的 has_more + last_id 用 after_id 续页', () => {
    assert.deepEqual(
        parseModelPage({
            data: [model('claude-sonnet-4-5')],
            has_more: true,
            first_id: 'claude-sonnet-4-5',
            last_id: 'claude-sonnet-4-5',
        }).next,
        { param: 'after_id', token: 'claude-sonnet-4-5' },
    )
    // 缺少 has_more 时不按 last_id 猜续页，避免服务端复述 last_id 导致翻页不终止。
    assert.equal(
        parseModelPage({ data: [model('chat')], last_id: 'chat' }).next,
        undefined,
    )
})
