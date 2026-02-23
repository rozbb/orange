#!/usr/bin/env node

import { createHash } from 'crypto'
import { watch } from 'fs'
import { readdir, readFile, writeFile } from 'fs/promises'
import { join, relative } from 'path'

const BUILD_DIRS = ['public/build', 'build', 'public/e2ee/wasm-pkg']
const OUTPUT_FILE = 'public/build/asset-manifest.json'

async function getFilesRecursively(dir, baseDir = dir) {
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await getFilesRecursively(fullPath, baseDir)))
    } else if (entry.isFile()) {
      files.push({
        fullPath,
        relativePath: relative(baseDir, fullPath),
      })
    }
  }
  return files
}

async function computeSha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('base64')
}

async function generateManifest() {
  const manifest = {}

  for (const buildDir of BUILD_DIRS) {
    const files = await getFilesRecursively(buildDir)

    for (const { fullPath, relativePath } of files) {
      const filePath = join(buildDir, relativePath)
      // Strip public/ prefix so keys are URL paths (e.g. /build/foo.js)
      const key = '/' + filePath.replace(/^public\//, '')
      const hash = await computeSha256(fullPath)
      manifest[key] = hash
    }
  }

  // Sort keys for consistent output
  const hashes = Object.keys(manifest)
    .sort()
    .reduce((acc, key) => {
      acc[key] = manifest[key]
      return acc
    }, {})

  const output = {
    hashes,
    wildcard_hashes: [],
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n')

  const count = Object.keys(hashes).length
  console.log(`Generated ${OUTPUT_FILE} with ${count} entries`)
}

if (process.argv.includes('--watch')) {
  generateManifest()
    .then(() => {
      let timeout
      const outputBasename = OUTPUT_FILE.split('/').pop()
      const regenerate = (_event, filename) => {
        if (filename === outputBasename) return
        clearTimeout(timeout)
        timeout = setTimeout(() => {
          generateManifest().catch((err) => {
            console.error('Failed to regenerate asset manifest:', err)
          })
        }, 100)
      }

      for (const dir of BUILD_DIRS) {
        try {
          watch(dir, { recursive: true }, regenerate)
          console.log(`Watching ${dir} for changes...`)
        } catch {
          // Directory may not exist yet
        }
      }
    })
    .catch((err) => {
      console.error('Failed to generate asset manifest:', err)
      process.exit(1)
    })
} else {
  generateManifest().catch((err) => {
    console.error('Failed to generate asset manifest:', err)
    process.exit(1)
  })
}
