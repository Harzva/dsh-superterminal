import { cp, mkdir, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, stdio: 'inherit' })
await mkdir(join(root, 'lib'), { recursive: true })
for (const file of await readdir(join(root, 'src'), { withFileTypes: true })) {
  if (file.isFile() && file.name.endsWith('.mjs') && file.name !== 'client-plugin.mjs') {
    await cp(join(root, 'src', file.name), join(root, 'lib', file.name))
  }
}
