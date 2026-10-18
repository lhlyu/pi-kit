import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRelease } from '../scripts/verify-release.ts'

const pkg = { name: '@lhlyu/pi-kit', version: '1.2.3' }
const sha = 'a'.repeat(40)

function registry(status: number, body: unknown = {}): typeof fetch {
    return async () => new Response(JSON.stringify(body), { status })
}

test('npm 返回 404 时准备发布，并对包名编码、为请求设置超时', async () => {
    const request: typeof fetch = async (input, options) => {
        assert.equal(
            input,
            'https://registry.npmjs.org/%40lhlyu%2Fpi-kit/1.2.3',
        )
        assert.ok(options?.signal instanceof AbortSignal)
        return new Response(null, { status: 404 })
    }
    assert.deepEqual(await checkRelease(pkg, sha, request), {
        version: '1.2.3',
        publish: true,
        release: true,
    })
})

test('已存在的 npm 版本不重复上传；同一提交允许补建 GitHub Release', async () => {
    const request = registry(200, { version: pkg.version, gitHead: sha })
    assert.deepEqual(await checkRelease(pkg, sha, request), {
        version: '1.2.3',
        publish: false,
        release: true,
    })
})

test('版本已存在时，不把后续提交或缺失 gitHead 的版本标为新 Release', async () => {
    for (const gitHead of [undefined, 'b'.repeat(40), null]) {
        const result = await checkRelease(
            pkg,
            sha,
            registry(200, { version: pkg.version, gitHead }),
        )
        assert.equal(result.publish, false)
        assert.equal(result.release, false)
    }
})

test('支持零版本号和多位正式版本号', async () => {
    for (const version of ['0.0.0', '0.1.0', '10.20.30']) {
        const result = await checkRelease(
            { ...pkg, version },
            sha,
            registry(404),
        )
        assert.equal(result.version, version)
        assert.equal(result.publish, true)
    }
})

test('缺失、非正式和无效版本在网络请求前拒绝', async () => {
    const request: typeof fetch = async () => {
        assert.fail('无效版本不应请求 npm')
    }
    for (const version of [
        undefined,
        '',
        '01.2.3',
        '1.2',
        '1.2.3-rc.1',
        '1.2.3+build',
        '1.2.3\n',
        ' 1.2.3',
    ]) {
        await assert.rejects(checkRelease({ ...pkg, version }, sha, request))
    }
    await assert.rejects(checkRelease({ ...pkg, name: '' }, sha, request))
})

test('认证、限流和服务端错误不能被当作版本不存在', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
        await assert.rejects(
            checkRelease(pkg, sha, registry(status)),
            new RegExp(`查询 npm 版本失败：HTTP ${status}`),
        )
    }
})

test('网络故障和超时会终止发布检查', async () => {
    const request: typeof fetch = async () => {
        throw new Error('网络故障或超时')
    }
    await assert.rejects(checkRelease(pkg, sha, request), /网络故障或超时/)
})

test('不接受 npm 返回的错误版本或无效 JSON', async () => {
    await assert.rejects(
        checkRelease(pkg, sha, registry(200, { version: '9.9.9' })),
        /npm 返回的版本信息不匹配/,
    )
    await assert.rejects(
        checkRelease(pkg, sha, async () => new Response('invalid json')),
        SyntaxError,
    )
})
