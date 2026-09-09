// Version-pinned bridge to a private field in the published local provider.
// The original handle remains owned and terminated by DSH; nothing is patched.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SUPPORTED = new Set(['0.1.1-rc.2'])
const version = name => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version

export class PtyCompatibilityError extends Error {
  constructor(message) { super(`DSH Terminal PTY compatibility: ${message}`); this.name = 'PtyCompatibilityError' }
}

/** Reject other execution worlds before any terminal is allocated. */
export async function assertLocalProvider(provider) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new PtyCompatibilityError('this alpha requires a POSIX local provider')
  let versions
  let LocalSubprocessRuntime
  try {
    versions = { subprocess: version('@deepseek-ai/dsh-subprocess'), local: version('@deepseek-ai/dsh-subprocess-local') }
    LocalSubprocessRuntime = (await import('@deepseek-ai/dsh-subprocess-local')).default
  } catch {
    throw new PtyCompatibilityError('the official subprocess/local peer packages must be installed in this DSH runtime')
  }
  if (!SUPPORTED.has(versions.local) || versions.subprocess !== versions.local) {
    throw new PtyCompatibilityError(`requires matching published subprocess/local ${[...SUPPORTED].join(' or ')}; found ${versions.subprocess}/${versions.local}`)
  }
  if (!(provider instanceof LocalSubprocessRuntime) || Object.getPrototypeOf(provider) !== LocalSubprocessRuntime.prototype) {
    throw new PtyCompatibilityError('remote and replacement subprocess providers are unsupported')
  }
}

/**
 * Return an independent facade. The caller must retain the original handle
 * before calling this function so a rejected adapter still receives cleanup.
 */
export function adaptLocalTerminalHandle(handle) {
  const terminal = Object.getOwnPropertyDescriptor(handle, 'terminal')?.value
  if (Object.getPrototypeOf(handle)?.constructor?.name !== 'LocalTerminalHandle'
    || !terminal || terminal.pid !== handle.pid || !Number.isSafeInteger(handle.pid) || handle.pid <= 0
    || typeof terminal.resize !== 'function' || typeof terminal.write !== 'function'
    || typeof terminal.kill !== 'function' || typeof handle.exited !== 'boolean'
    || !Object.hasOwn(handle, 'cleanup') || typeof handle.terminate !== 'function'
    || typeof handle.write !== 'function' || typeof handle.inspectForeground !== 'function'
    || typeof handle.signalForeground !== 'function' || typeof handle.done?.then !== 'function'
    || typeof handle.output?.on !== 'function') {
    throw new PtyCompatibilityError('published LocalTerminalHandle structure changed; original handle will be terminated')
  }
  return Object.freeze({
    pid: handle.pid,
    output: handle.output,
    done: handle.done,
    write: data => handle.write(data),
    inspectForeground: () => handle.inspectForeground(),
    signalForeground: signal => handle.signalForeground(signal),
    terminate: () => handle.terminate(),
    async resize(rows, cols) {
      if (handle.exited) throw new Error('terminal process has exited')
      if (handle.cleanup !== undefined) throw new Error('terminal process is closing')
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 4096 || cols > 4096) {
        throw new RangeError('terminal rows and cols must be integers between 1 and 4096')
      }
      terminal.resize(cols, rows)
    },
  })
}

export const localPtyCompatibility = Object.freeze({ assertProvider: assertLocalProvider, adaptHandle: adaptLocalTerminalHandle })
