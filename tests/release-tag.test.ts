import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { checkReleaseTag } from '../scripts/verify-release-tag.ts'

const options = {
    repository: 'lhlyu/pi-kit',
    version: '1.2.3',
    sha: 'a'.repeat(40),
    token: 'test-token',
}
const tagSha = 'b'.repeat(40)
const base = 'https://api.github.com/repos/lhlyu/pi-kit/git'

function github(status: number, body: unknown = {}): typeof fetch {
    return async () => new Response(JSON.stringify(body), { status })
}

test('标签不存在时允许创建，查询携带鉴权和超时', async () => {
    await checkReleaseTag(options, async (input, init) => {
        assert.equal(input, `${base}/ref/tags/v1.2.3`)
        assert.equal(
            new Headers(init?.headers).get('Authorization'),
            'Bearer test-token',
        )
        assert.ok(init?.signal instanceof AbortSignal)
        return new Response(null, { status: 404 })
    })
})

test('轻量标签指向当前提交时通过', async () => {
    await checkReleaseTag(
        options,
        github(200, {
            object: { type: 'commit', sha: options.sha },
        }),
    )
})

test('附注标签逐层解引用后与提交比较，而不是比较标签对象 SHA', async () => {
    const nestedTagSha = 'c'.repeat(40)
    const urls: unknown[] = []
    const objects = [
        { type: 'tag', sha: tagSha },
        { type: 'tag', sha: nestedTagSha },
        { type: 'commit', sha: options.sha },
    ]
    await checkReleaseTag(options, async (url) => {
        urls.push(url)
        return new Response(JSON.stringify({ object: objects.shift() }))
    })
    assert.deepEqual(urls, [
        `${base}/ref/tags/v1.2.3`,
        `${base}/tags/${tagSha}`,
        `${base}/tags/${nestedTagSha}`,
    ])
})

test('轻量或附注标签指向其他提交时均拒绝', async () => {
    await assert.rejects(
        checkReleaseTag(
            options,
            github(200, {
                object: { type: 'commit', sha: tagSha },
            }),
        ),
        /指向其他提交/,
    )
    let calls = 0
    await assert.rejects(
        checkReleaseTag(options, async () => {
            calls++
            return new Response(
                JSON.stringify({
                    object:
                        calls === 1
                            ? { type: 'tag', sha: tagSha }
                            : { type: 'commit', sha: tagSha },
                }),
            )
        }),
        /指向其他提交/,
    )
    assert.equal(calls, 2)
})

test('鉴权、限流和服务端错误终止校验，不当作标签不存在', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
        await assert.rejects(
            checkReleaseTag(options, github(status)),
            new RegExp(`HTTP ${status}`),
        )
    }
})

test('附注标签解引用时遇到 404 也必须终止', async () => {
    let calls = 0
    await assert.rejects(
        checkReleaseTag(options, async () => {
            calls++
            return calls === 1
                ? new Response(
                      JSON.stringify({ object: { type: 'tag', sha: tagSha } }),
                  )
                : new Response(null, { status: 404 })
        }),
        /HTTP 404/,
    )
    assert.equal(calls, 2)
})

test('网络异常或无效 JSON 终止校验', async () => {
    await assert.rejects(
        checkReleaseTag(options, async () => {
            throw new Error('网络故障或超时')
        }),
        /网络故障或超时/,
    )
    await assert.rejects(
        checkReleaseTag(options, async () => new Response('invalid json')),
        SyntaxError,
    )
})

test('缺失或异常标签对象不能通过校验', async () => {
    for (const body of [
        null,
        {},
        { object: null },
        { object: { type: 'commit' } },
        { object: { type: 'commit', sha: 'invalid' } },
        { object: { type: 'tree', sha: options.sha } },
        { object: { sha: options.sha } },
    ]) {
        await assert.rejects(checkReleaseTag(options, github(200, body)))
    }
})

test('异常引用链有界，不会无限查询', async () => {
    let calls = 0
    await assert.rejects(
        checkReleaseTag(options, async () => {
            calls++
            return new Response(
                JSON.stringify({ object: { type: 'tag', sha: tagSha } }),
            )
        }),
        /引用链过深/,
    )
    assert.equal(calls, 10)
})

test('无效仓库名、版本号和提交 SHA 在请求前拒绝', async () => {
    const request: typeof fetch = async () =>
        assert.fail('无效参数不应请求 GitHub')
    for (const input of [
        { ...options, repository: '../other/repo' },
        { ...options, version: '1.2.3\n' },
        { ...options, sha: 'invalid' },
    ]) {
        await assert.rejects(checkReleaseTag(input, request))
    }
})

test('工作流在上传 npm 前及创建或跳过 Release 前均执行标签校验', () => {
    const workflow = readFileSync(
        new URL('../.github/workflows/publish.yml', import.meta.url),
        'utf8',
    )
    const verify =
        'node --experimental-strip-types scripts/verify-release-tag.ts'
    const first = workflow.indexOf(verify)
    const publish = workflow.indexOf('run: npm publish --provenance')
    const second = workflow.indexOf(verify, first + verify.length)
    const release = workflow.indexOf('if gh release view')
    assert.ok(first >= 0 && first < publish)
    assert.ok(second > publish && second < release)
})
