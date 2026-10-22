import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import discoveryExtension from './discovery-extension.ts'
import statusExtension from './status-extension.ts'

/**
 * 本地开发入口，同时加载状态栏和模型发现。
 * 发布包通过 package.json 的 `pi.extensions` 分别加载两个入口。
 */
export default async function piKit(pi: ExtensionAPI): Promise<void> {
    statusExtension(pi)
    await discoveryExtension(pi)
}
