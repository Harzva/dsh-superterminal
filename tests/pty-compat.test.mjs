import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { adaptLocalTerminalHandle, PtyCompatibilityError } from '../src/pty-compat.mjs'

// Pins only the inspected private boundary, not a replacement DSH provider.
class LocalTerminalHandle {
  constructor() {
    this.pid = 123
    this.output = new PassThrough()
    this.finished = Promise.withResolvers()
    this.done = this.finished.promise
    this.exited = false
    this.cleanup = undefined
    this.resizes = []
    this.writes = []
    this.terminal = { pid: 123, resize: (cols, rows) => this.resizes.push([cols, rows]), write() {}, kill() {} }
  }
  async write(data) { this.writes.push(data) }
  async inspectForeground() { return { processGroupId: 456, inputWaiting: true } }
  async signalForeground() { return 456 }
  async terminate() { this.cleanup = Promise.resolve(); this.exited = true; this.output.end(); this.finished.resolve({ exitCode: 0, signal: null }) }
}

test('the facade preserves the original owner handle without adding or replacing methods', async () => {
  const original = new LocalTerminalHandle()
  const descriptors = Object.getOwnPropertyDescriptors(original)
  const facade = adaptLocalTerminalHandle(original)
  assert.notEqual(facade, original)
  assert.equal(facade.done, original.done)
  assert.equal(facade.output, original.output)
  assert.equal(original.resize, undefined)
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), descriptors)
  await facade.resize(32, 117)
  assert.deepEqual(original.resizes, [[117, 32]])
  await facade.write('hello')
  assert.deepEqual(original.writes, ['hello'])
  assert.equal((await facade.inspectForeground()).processGroupId, 456)
  assert.equal(await facade.signalForeground('SIGINT'), 456)
  original.cleanup = Promise.resolve()
  await assert.rejects(facade.resize(20, 80), /closing/)
  original.cleanup = undefined
  await facade.terminate()
  await assert.rejects(facade.resize(20, 80), /exited/)
})

test('invalid native sizes reject before crossing into the private native object', async () => {
  const original = new LocalTerminalHandle()
  const facade = adaptLocalTerminalHandle(original)
  for (const value of [0, -1, 1.2, NaN, Infinity, 4097]) {
    await assert.rejects(facade.resize(value, 80), RangeError)
    await assert.rejects(facade.resize(24, value), RangeError)
  }
  assert.deepEqual(original.resizes, [])
  await facade.terminate()
})

test('changed private handle identity, PID, or required structure fails closed', async () => {
  for (const mutate of [
    handle => { handle.terminal.pid = 456 },
    handle => { delete handle.cleanup },
    handle => { handle.terminal.resize = undefined },
    handle => { handle.exited = undefined },
    handle => { Object.setPrototypeOf(handle, Object.prototype) },
  ]) {
    const original = new LocalTerminalHandle()
    mutate(original)
    assert.throws(() => adaptLocalTerminalHandle(original), PtyCompatibilityError)
    original.output.end()
  }
})
