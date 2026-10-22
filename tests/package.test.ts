import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    files?: string[]
    pi?: { extensions?: string[] }
}

test('Pi manifest 声明的每个扩展入口都存在', () => {
    assert.ok(pkg.pi?.extensions?.length)
    for (const entry of pkg.pi.extensions)
        assert.ok(existsSync(join(root, entry)), entry)
})

test('发布文件清单包含扩展和文档目录', () => {
    assert.ok(pkg.files?.includes('src/'))
    assert.ok(pkg.files?.includes('docs/'))
})
