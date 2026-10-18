import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModelList, matchModels } from '../src/model-catalog.ts'
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
        assert.deepEqual(
            parseModelList({ data: [model('chat')], [field]: null }),
            ['chat'],
        )
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
    ]
    const chat = ['gpt-4o', 'my-custom-model', 'embedding-expert-chat']
    assert.deepEqual(
        parseModelList({ data: [...nonChat, ...chat].map(model) }),
        chat.sort(),
    )
    assert.deepEqual(matchModels(nonChat, [], 'openai-completions'), [])
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
