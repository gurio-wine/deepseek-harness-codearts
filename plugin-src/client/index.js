/**
 * Account Hub 管理页面客户端插件。
 *
 * 注册 Account Hub 设置页面到 DSH settings.section slot。
 */

export const name = 'jet-hub-client'
export const inject = ['slots', 'connection']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL, JetHubPage } from './jet-hub.js'

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jet-hub',
    order: 50,
    label: () => 'Account Hub',
    inject: () => ({ rpcCall }),
  }, JetHubPage))
}
