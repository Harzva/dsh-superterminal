import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { captureDelegatedPolicyOverrides, appendDelegatedPolicyOverrides, applyChildComposition } from '@deepseek-ai/dsh-subagent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { NativeTerminals } from './terminals.mjs'

export const name = 'dsh-terminal'
export const inject = ['subprocess', 'sandboxPolicy', 'agents']

export function apply(ctx) {
  const service = new NativeTerminals(ctx, effectiveSandboxMode, undefined, {
    captureDelegatedPolicyOverrides, appendDelegatedPolicyOverrides, applyChildComposition, installModelSelection,
  })
  service.typertRemote = bindTypertRemote(service, 'dshTerminal')
  ctx.provide('dshTerminal', service)
  ctx.effect(() => () => service.stop(), 'native terminals: plugin cleanup')
}
