import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { discoverProviders } from './model-discovery.ts'
import registerStatus from './status-extension.ts'

export default async function piKit(pi: ExtensionAPI): Promise<void> {
    registerStatus(pi)
    await discoverProviders(pi, { agentDir: getAgentDir() })
}
