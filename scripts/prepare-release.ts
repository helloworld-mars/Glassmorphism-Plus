import { Buffer } from 'node:buffer'
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

import { ensureReleaseWorkspace, getReleasePaths, THEME_VERSION_RE } from './release-paths'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const THEME_MANIFEST_FILE = 'komari-theme.json'
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054B50
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014B50
const ZIP_LOCAL_FILE_HEADER = 0x04034B50
const ZIP_STORED = 0
const ZIP_DEFLATED = 8
const PATH_SEPARATOR_RE = /[\\/]/

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.turbo',
  '.vite',
  'coverage',
  'logs',
  'node_modules',
  'playwright-report',
  'temp',
  'test-results',
  'tmp',
])
const EXCLUDED_FILE_NAMES = new Set([
  '.eslintcache',
  'aicache.md',
  'bun.lock',
])
const EXCLUDED_FILE_SUFFIXES = [
  '.cache',
  '.cer',
  '.crt',
  '.db',
  '.har',
  '.key',
  '.log',
  '.p12',
  '.pfx',
  '.pem',
  '.sqlite',
  '.sqlite3',
  '.tsbuildinfo',
  '.zip',
]

interface ThemeManifest {
  version?: unknown
}

interface ZipEntry {
  name: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function readManifestVersion(manifestPath: string, label: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ThemeManifest
  const version = manifest.version

  if (typeof version !== 'string' || version !== version.trim() || !THEME_VERSION_RE.test(version)) {
    throw new Error(`${label} does not contain a valid top-level version`)
  }

  return version
}

function assertBufferRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Invalid ZIP ${label} range`)
  }
}

function findEndOfCentralDirectory(zipBuffer: Buffer): number {
  const firstPossibleOffset = Math.max(0, zipBuffer.length - 0xFFFF - 22)

  for (let offset = zipBuffer.length - 22; offset >= firstPossibleOffset; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset
    }
  }

  throw new Error('ZIP end-of-central-directory record was not found')
}

function readZipEntries(zipBuffer: Buffer): ZipEntry[] {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectory(zipBuffer)
  assertBufferRange(zipBuffer, endOfCentralDirectoryOffset, 22, 'end-of-central-directory')

  const diskNumber = zipBuffer.readUInt16LE(endOfCentralDirectoryOffset + 4)
  const centralDirectoryDisk = zipBuffer.readUInt16LE(endOfCentralDirectoryOffset + 6)
  const entriesOnDisk = zipBuffer.readUInt16LE(endOfCentralDirectoryOffset + 8)
  const entryCount = zipBuffer.readUInt16LE(endOfCentralDirectoryOffset + 10)
  const centralDirectorySize = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 12)
  const centralDirectoryOffset = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 16)

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported for release verification')
  }

  if (entryCount === 0xFFFF || centralDirectorySize === 0xFFFFFFFF || centralDirectoryOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 archives are not supported for release verification')
  }

  assertBufferRange(zipBuffer, centralDirectoryOffset, centralDirectorySize, 'central-directory')
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  const entries: ZipEntry[] = []
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    assertBufferRange(zipBuffer, offset, 46, 'central-directory entry')
    if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error('Invalid ZIP central-directory entry')
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 10)
    const compressedSize = zipBuffer.readUInt32LE(offset + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24)
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28)
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30)
    const fileCommentLength = zipBuffer.readUInt16LE(offset + 32)
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42)
    const entrySize = 46 + fileNameLength + extraFieldLength + fileCommentLength

    if (offset + entrySize > centralDirectoryEnd) {
      throw new Error('ZIP central-directory entry exceeds the declared directory size')
    }

    const name = zipBuffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8')
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    offset += entrySize
  }

  return entries
}

function readZipEntry(zipBuffer: Buffer, entry: ZipEntry): Buffer {
  assertBufferRange(zipBuffer, entry.localHeaderOffset, 30, `${entry.name} local header`)
  if (zipBuffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`)
  }

  const fileNameLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26)
  const extraFieldLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28)
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength
  assertBufferRange(zipBuffer, dataOffset, entry.compressedSize, `${entry.name} data`)

  const compressedData = zipBuffer.subarray(dataOffset, dataOffset + entry.compressedSize)
  const data = entry.compressionMethod === ZIP_STORED
    ? Buffer.from(compressedData)
    : entry.compressionMethod === ZIP_DEFLATED
      ? inflateRawSync(compressedData)
      : undefined

  if (!data) {
    throw new Error(`Unsupported ZIP compression method for ${entry.name}`)
  }

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`ZIP size verification failed for ${entry.name}`)
  }

  return data
}

function verifyInstallerZip(installerPath: string, expectedVersion: string): void {
  if (!existsSync(installerPath) || !statSync(installerPath).isFile()) {
    throw new Error(`Expected installer ZIP does not exist: ${installerPath}`)
  }

  const zipBuffer = readFileSync(installerPath)
  const entries = readZipEntries(zipBuffer)
  const rootManifestEntries = entries.filter(entry => entry.name === THEME_MANIFEST_FILE)

  if (rootManifestEntries.length !== 1) {
    throw new Error('Installer ZIP must contain exactly one root komari-theme.json')
  }

  if (!entries.some(entry => entry.name === 'preview.png')) {
    throw new Error('Installer ZIP is missing root preview.png')
  }

  if (!entries.some(entry => entry.name.startsWith('dist/'))) {
    throw new Error('Installer ZIP is missing the dist/ payload')
  }

  const forbiddenPrefixes = ['.git/', 'node_modules/', 'playwright-report/', 'src/', 'test-results/', 'tests/']
  const forbiddenEntry = entries.find(entry => forbiddenPrefixes.some(prefix => entry.name.startsWith(prefix)))
  if (forbiddenEntry) {
    throw new Error(`Installer ZIP contains a forbidden entry: ${forbiddenEntry.name}`)
  }

  const zipVersion = readManifestVersionFromBuffer(readZipEntry(zipBuffer, rootManifestEntries[0]), 'Installer ZIP metadata')
  if (zipVersion !== expectedVersion) {
    throw new Error(`Installer ZIP metadata version ${zipVersion} does not match source version ${expectedVersion}`)
  }
}

function readManifestVersionFromBuffer(buffer: Buffer, label: string): string {
  const manifest = JSON.parse(buffer.toString('utf8')) as ThemeManifest
  const version = manifest.version

  if (typeof version !== 'string' || version !== version.trim() || !THEME_VERSION_RE.test(version)) {
    throw new Error(`${label} does not contain a valid top-level version`)
  }

  return version
}

function isExcludedRelativePath(relativePath: string): boolean {
  if (!relativePath) {
    return false
  }

  const pathSegments = relativePath.split(PATH_SEPARATOR_RE)
  const lowerCaseSegments = pathSegments.map(segment => segment.toLowerCase())
  const fileName = lowerCaseSegments.at(-1)!

  if (lowerCaseSegments.some(segment => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return true
  }

  if (EXCLUDED_FILE_NAMES.has(fileName) || fileName === '.env' || fileName.startsWith('.env.')) {
    return true
  }

  return EXCLUDED_FILE_SUFFIXES.some(suffix => fileName.endsWith(suffix)) || fileName.endsWith('.local')
}

function shouldCopySnapshotPath(sourcePath: string): boolean {
  const sourceRelativePath = relative(PROJECT_ROOT, sourcePath)
  return !lstatSync(sourcePath).isSymbolicLink() && !isExcludedRelativePath(sourceRelativePath)
}

function assertSnapshotTargetIsUsable(releaseDirectory: string): boolean {
  if (!existsSync(releaseDirectory)) {
    return false
  }

  if (!lstatSync(releaseDirectory).isDirectory()) {
    throw new Error(`Release snapshot target is not a directory: ${releaseDirectory}`)
  }

  if (readdirSync(releaseDirectory).length > 0) {
    throw new Error(`Release snapshot target already exists and is not empty: ${releaseDirectory}`)
  }

  return true
}

function copyReleaseSnapshot(releaseDirectory: string): void {
  const targetExistsAndIsEmpty = assertSnapshotTargetIsUsable(releaseDirectory)

  if (targetExistsAndIsEmpty) {
    cpSync(PROJECT_ROOT, releaseDirectory, { recursive: true, filter: shouldCopySnapshotPath })
    return
  }

  const partialDirectory = `${releaseDirectory}.partial-${process.pid}`
  if (existsSync(partialDirectory)) {
    throw new Error(`Refusing to reuse an existing partial snapshot directory: ${partialDirectory}`)
  }

  cpSync(PROJECT_ROOT, partialDirectory, { recursive: true, filter: shouldCopySnapshotPath })
  renameSync(partialDirectory, releaseDirectory)
}

function findExcludedSnapshotEntry(directory: string, rootDirectory = directory): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name)
    const snapshotRelativePath = relative(rootDirectory, entryPath)

    if (entry.isSymbolicLink() || isExcludedRelativePath(snapshotRelativePath)) {
      return snapshotRelativePath
    }

    if (entry.isDirectory()) {
      const nestedExcludedEntry = findExcludedSnapshotEntry(entryPath, rootDirectory)
      if (nestedExcludedEntry) {
        return nestedExcludedEntry
      }
    }
  }

  return undefined
}

function verifyReleaseSnapshot(releaseDirectory: string, expectedVersion: string): void {
  const copiedManifestPath = resolve(releaseDirectory, THEME_MANIFEST_FILE)
  const copiedDistPath = resolve(releaseDirectory, 'dist')

  if (!existsSync(copiedDistPath) || !statSync(copiedDistPath).isDirectory()) {
    throw new Error('Release snapshot is missing dist/')
  }

  const copiedVersion = readManifestVersion(copiedManifestPath, 'Release snapshot metadata')
  if (copiedVersion !== expectedVersion) {
    throw new Error(`Release snapshot metadata version ${copiedVersion} does not match source version ${expectedVersion}`)
  }

  const excludedEntry = findExcludedSnapshotEntry(releaseDirectory)
  if (excludedEntry) {
    throw new Error(`Release snapshot contains an excluded artifact: ${excludedEntry}`)
  }
}

function main(): void {
  const sourceVersion = readManifestVersion(resolve(PROJECT_ROOT, THEME_MANIFEST_FILE), 'Source metadata')
  const releasePaths = getReleasePaths(PROJECT_ROOT, sourceVersion)
  const sourceDistPath = resolve(PROJECT_ROOT, 'dist')

  if (!existsSync(sourceDistPath) || !statSync(sourceDistPath).isDirectory()) {
    throw new Error('Build output dist/ is required before preparing a release snapshot')
  }

  // Verify the final installer before creating any release workspace or copying files.
  verifyInstallerZip(releasePaths.installerPath, sourceVersion)
  ensureReleaseWorkspace(PROJECT_ROOT, sourceVersion)
  copyReleaseSnapshot(releasePaths.releaseDirectory)
  verifyReleaseSnapshot(releasePaths.releaseDirectory, sourceVersion)

  console.log(`[release:prepare] Verified installer ZIP: ${releasePaths.installerPath}`)
  console.log(`[release:prepare] Created release snapshot: ${releasePaths.releaseDirectory}`)
  console.log(`[release:prepare] Publish snapshot path reserved: ${releasePaths.publishDirectory}`)
  console.log('[release:prepare] Git staging and GitHub Release asset uploads remain manual.')
}

try {
  main()
}
catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
