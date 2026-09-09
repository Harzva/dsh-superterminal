import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
export async function installedVersion(executable) {
  try {
    let dir = dirname(await realpath(executable))
    for (let i = 0; i < 7; i++) {
      try {
        const file = join(dir, 'package.json')
        if ((await stat(file)).size < 262144) {
          const pkg = JSON.parse(await readFile(file, 'utf8'))
          if (pkg.bin && typeof pkg.version === 'string' && /^[0-9][\w.+-]{0,63}$/.test(pkg.version)) return pkg.version
        }
      } catch {}
      const parent = dirname(dir); if (parent === dir) break; dir = parent
    }
  } catch {}
  return null
}
