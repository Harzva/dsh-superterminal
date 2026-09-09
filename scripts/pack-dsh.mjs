import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' })
await mkdir(join(root, 'artifacts'), { recursive: true })
const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', 'artifacts'], { cwd: root, encoding: 'utf8' })
const [packed] = JSON.parse(output)
const required = ['package.json', 'lib/host.mjs', 'lib/terminals.mjs', 'lib/pty-compat.mjs', 'lib/remote.mjs', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']
const actual = new Set(packed.files.map(file => file.path))
for (const file of required) if (!actual.has(file)) throw new Error(`Missing release file: ${file}`)
for (const file of actual) {
  if (!required.includes(file) && !file.startsWith('lib/')) throw new Error(`Unexpected release file: ${file}`)
}
const path = join(root, 'artifacts', packed.filename)
const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
await writeFile(join(root, 'artifacts', 'pack-manifest.json'), JSON.stringify({ name: packed.name, version: packed.version, filename: packed.filename, sha256, files: [...actual] }, null, 2) + '\n')
console.log(`Packed ${packed.filename} (${packed.size} bytes); SHA-256 ${sha256}`)
