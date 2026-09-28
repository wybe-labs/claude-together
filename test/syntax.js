// Every entry point must at least parse. The suites below exercise the transport and
// store, but nothing imports src/server.js (it starts an MCP server on import), so a
// syntax error there — say, an unescaped quote in a tool description — would pass
// every test and then stop the server from starting at all.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['src', 'scripts', 'test'].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(root, dir, f)))

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    failed++
    console.error(`${path.relative(root, file)}:\n${String(err.stderr || err.message).trim()}\n`)
  }
}
if (failed) {
  console.error(`${failed} file(s) do not parse.`)
  process.exit(1)
}
console.log(`All ${files.length} source files parse.`)
