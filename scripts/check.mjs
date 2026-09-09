import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = args => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
run(['scripts/build.mjs'])
run(['node_modules/typescript/bin/tsc', '--noEmit'])
const tests = (await readdir(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`)
run(['--test', ...tests])
