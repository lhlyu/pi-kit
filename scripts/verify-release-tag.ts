import assert from 'node:assert/strict'

export async function checkReleaseTag(
    {
        repository,
        version,
        sha,
        token,
    }: { repository: string; version: string; sha: string; token: string },
    request: typeof fetch = fetch,
): Promise<void> {
    for (const value of [repository, version, sha]) {
        assert.equal(value, value.trim(), '发布参数不能包含首尾空白')
    }
    assert.match(repository, /^[\w.-]+\/[\w.-]+$/, '无效的 GitHub 仓库名')
    assert.match(
        version,
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
        '无效的版本号',
    )
    assert.match(sha, /^[0-9a-f]{40}$/, '无效的提交 SHA')

    const tag = `v${version}`
    const base = `https://api.github.com/repos/${repository}/git`
    let url = `${base}/ref/tags/${tag}`
    // 附注标签可能指向另一个标签；设置上限以拒绝异常引用链。
    for (let depth = 0; depth < 10; depth++) {
        const response = await request(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(30_000),
        })
        // 只有最初查询标签引用的 404 表示可创建，解引用失败必须终止。
        if (depth === 0 && response.status === 404) return
        assert.equal(
            response.status,
            200,
            `查询 GitHub 标签失败：HTTP ${response.status}`,
        )
        const metadata = (await response.json()) as {
            object?: { type?: unknown; sha?: unknown }
        }
        const object = metadata?.object
        assert.ok(
            object && typeof object.sha === 'string',
            'GitHub 返回的标签对象无效',
        )
        assert.match(object.sha, /^[0-9a-f]{40}$/, 'GitHub 返回的标签 SHA 无效')
        if (object.type === 'commit') {
            assert.equal(
                object.sha,
                sha,
                `标签 ${tag} 指向其他提交，拒绝发布或创建 Release`,
            )
            return
        }
        assert.equal(object.type, 'tag', 'GitHub 标签未指向提交或附注标签')
        url = `${base}/tags/${object.sha}`
    }
    assert.fail(`标签 ${tag} 的引用链过深，拒绝发布或创建 Release`)
}

if (import.meta.main) {
    const { GITHUB_REPOSITORY, GITHUB_SHA, VERSION, GH_TOKEN } = process.env
    assert.ok(GITHUB_REPOSITORY, '缺少 GITHUB_REPOSITORY')
    assert.ok(GITHUB_SHA, '缺少 GITHUB_SHA')
    assert.ok(VERSION, '缺少 VERSION')
    assert.ok(GH_TOKEN, '缺少 GH_TOKEN')
    await checkReleaseTag({
        repository: GITHUB_REPOSITORY,
        version: VERSION,
        sha: GITHUB_SHA,
        token: GH_TOKEN,
    })
    console.log(`v${VERSION}：标签校验通过`)
}
