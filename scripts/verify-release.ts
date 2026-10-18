import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'

export async function checkRelease(
    { name, version }: { name: unknown; version: unknown },
    sha: string,
    request: typeof fetch = fetch,
) {
    assert.ok(
        typeof name === 'string' && name.trim().length > 0,
        '缺少 npm 包名',
    )
    assert.ok(typeof version === 'string', '缺少包版本号')
    assert.equal(version, version.trim(), '版本号不能包含首尾空白')
    assert.match(
        version,
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
        '仅支持发布正式版本 X.Y.Z',
    )
    const response = await request(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
        { signal: AbortSignal.timeout(30_000) },
    )
    if (response.status === 404)
        return { version, publish: true, release: true }
    assert.equal(
        response.status,
        200,
        `查询 npm 版本失败：HTTP ${response.status}`,
    )

    const metadata = (await response.json()) as {
        version?: unknown
        gitHead?: unknown
    }
    assert.equal(metadata.version, version, 'npm 返回的版本信息不匹配')
    // 同一提交重跑时可补建 Release；不把后续提交误标为已发布版本。
    return { version, publish: false, release: metadata.gitHead === sha }
}

if (import.meta.main) {
    assert.ok(process.env.GITHUB_SHA, '缺少 GITHUB_SHA')
    assert.ok(process.env.GITHUB_OUTPUT, '缺少 GITHUB_OUTPUT')
    const pkg = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: unknown; version: unknown }
    const { version, publish, release } = await checkRelease(
        pkg,
        process.env.GITHUB_SHA,
    )
    appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${version}\npublish=${publish}\nrelease=${release}\n`,
    )
    console.log(`${version}：${publish ? '准备发布' : 'npm 已存在，跳过上传'}`)
}
