#!/usr/bin/env node

import { createHash } from 'crypto'
import { watch } from 'fs'
import { readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join, relative } from 'path'

const BUILD_DIRS = ['public/build', 'build', 'public/e2ee/wasm-pkg']
const FIXED_OUTPUT_FILE = 'public/build/asset-manifest.json'
const isWatch = process.argv.includes('--watch')

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
      // Skip asset-manifest files to avoid self-reference
      if (entry.name.startsWith('asset-manifest')) continue
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

async function cleanOldManifests(keepFile) {
  try {
    const entries = await readdir('public/build')
    for (const entry of entries) {
      if (entry.startsWith('asset-manifest-') && entry.endsWith('.json')) {
        const fullPath = join('public/build', entry)
        if (fullPath !== keepFile) {
          await unlink(fullPath)
        }
      }
    }
  } catch {
    // Directory may not exist
  }
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

  const jsonContent = JSON.stringify(output, null, 2) + '\n'

  let outputFile
  if (isWatch) {
    outputFile = FIXED_OUTPUT_FILE
  } else {
    const contentHash = createHash('sha256')
      .update(jsonContent)
      .digest('hex')
      .slice(0, 8)
    outputFile = `public/build/asset-manifest-${contentHash}.json`

    // Write the URL path for the deploy script to inject via --define
    await writeFile(
      'build/asset-manifest-path.txt',
      `/build/asset-manifest-${contentHash}.json`
    )

    // Clean up old hash-named manifests
    await cleanOldManifests(outputFile)
  }

  await writeFile(outputFile, jsonContent)

  const count = Object.keys(hashes).length
  console.log(`Generated ${outputFile} with ${count} entries`)
}

if (isWatch) {
  generateManifest()
    .then(() => {
      let timeout
      const regenerate = (_event, filename) => {
        // Ignore changes to manifest files to avoid infinite loops
        if (filename && filename.startsWith('asset-manifest')) return
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
