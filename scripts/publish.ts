import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { ensureReleaseWorkspace, THEME_VERSION_RE } from './release-paths'

const VERSION_FIELD_RE = /^(\s*"version"\s*:\s*")([^"]*)(")/m
const PATCH_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
const VERSION_SOURCE_FILE = 'komari-theme.json'
const PACKAGE_VERSION_FILE = 'package.json'
const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readThemeVersion(): string {
  const themeManifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, VERSION_SOURCE_FILE), 'utf8')) as { version?: unknown }

  if (typeof themeManifest.version !== 'string') {
    throw new TypeError(`${VERSION_SOURCE_FILE} does not contain a top-level string version field`)
  }

  return themeManifest.version
}

function bumpPatchVersion(version: string): string {
  const match = PATCH_VERSION_RE.exec(version)

  if (!match) {
    throw new Error(`Cannot auto bump non-standard version: ${version}`)
  }

  const [, major, minor, patch] = match
  return `${major}.${minor}.${Number(patch) + 1}`
}

function readVersionArg(): string | undefined {
  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '-v' || arg === '--version') {
      const version = args[i + 1]
      if (!version) {
        throw new Error('Missing version after -v/--version')
      }
      return version
    }

    if (arg.startsWith('--version=')) {
      return arg.slice('--version='.length)
    }
  }

  return undefined
}

async function resolveVersion(): Promise<string> {
  const versionArg = readVersionArg()

  if (versionArg) {
    return versionArg
  }

  const currentVersion = readThemeVersion()
  const nextVersion = bumpPatchVersion(currentVersion)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = (await rl.question(
      `No version provided. Use ${nextVersion} (${currentVersion} -> ${nextVersion})? Enter y to confirm, or enter another version: `,
    )).trim()

    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      return nextVersion
    }

    if (answer) {
      return answer
    }

    throw new Error('No version provided')
  }
  finally {
    rl.close()
  }
}

interface VersionFileUpdate {
  fileName: string
  filePath: string
  nextContent: string
}

function prepareVersionFileUpdate(fileName: string, version: string, required: boolean): VersionFileUpdate | undefined {
  const filePath = resolve(PROJECT_ROOT, fileName)
  const content = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(content) as { version?: unknown }

  if (typeof parsed.version !== 'string') {
    if (required) {
      throw new TypeError(`${fileName} does not contain a top-level string version field`)
    }

    return undefined
  }

  const nextContent = content.replace(VERSION_FIELD_RE, `$1${version}$3`)

  JSON.parse(nextContent)
  return { fileName, filePath, nextContent }
}

function prepareProjectVersionUpdates(version: string): VersionFileUpdate[] {
  const manifestUpdate = prepareVersionFileUpdate(VERSION_SOURCE_FILE, version, true)
  if (!manifestUpdate) {
    throw new Error(`Missing required version update for ${VERSION_SOURCE_FILE}`)
  }

  const updates: VersionFileUpdate[] = [manifestUpdate]

  // The manifest remains the canonical source; package.json only mirrors it when
  // this repository already carries package metadata for the same project.
  if (existsSync(resolve(PROJECT_ROOT, PACKAGE_VERSION_FILE))) {
    const packageUpdate = prepareVersionFileUpdate(PACKAGE_VERSION_FILE, version, false)
    if (packageUpdate) {
      updates.push(packageUpdate)
    }
  }

  return updates
}

function writeProjectVersionUpdates(updates: VersionFileUpdate[]): string[] {
  for (const update of updates) {
    writeFileSync(update.filePath, update.nextContent)
  }

  return updates.map(update => update.fileName)
}

async function main(): Promise<void> {
  const version = await resolveVersion()

  if (!THEME_VERSION_RE.test(version)) {
    throw new Error(`Invalid version: ${version}`)
  }

  const versionUpdates = prepareProjectVersionUpdates(version)
  const releasePaths = ensureReleaseWorkspace(PROJECT_ROOT, version)
  const versionFiles = writeProjectVersionUpdates(versionUpdates)
  console.log(`Prepared release version ${version}`)
  console.log(`Version source: ${VERSION_SOURCE_FILE}`)
  console.log(`Updated version files: ${versionFiles.join(', ')}`)
  console.log(`Release workspace: ${releasePaths.versionDirectory}`)
  console.log(`Publish snapshot path: ${releasePaths.publishDirectory}`)
  console.log(`Release snapshot path: ${releasePaths.releaseDirectory}`)
  console.log(`Installer path: ${releasePaths.installerPath}`)
  console.log('Git staging is intentionally manual; review and stage the selected publishing clone after copying validated source files.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
