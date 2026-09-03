import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
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
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Z]:/i

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
  generalPurposeBitFlag: number
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface InstallerVerification {
  directoryCount: number
  fileCount: number
  installerSha256: string
}

interface ExpectedInstallerEntries {
  directories: Set<string>
  files: Map<string, string>
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
  const commentLength = zipBuffer.readUInt16LE(endOfCentralDirectoryOffset + 20)

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported for release verification')
  }

  if (entryCount === 0xFFFF || centralDirectorySize === 0xFFFFFFFF || centralDirectoryOffset === 0xFFFFFFFF) {
    throw new Error('ZIP64 archives are not supported for release verification')
  }

  assertBufferRange(zipBuffer, centralDirectoryOffset, centralDirectorySize, 'central-directory')
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryEnd !== endOfCentralDirectoryOffset) {
    throw new Error('ZIP central-directory does not end at the end-of-central-directory record')
  }

  if (endOfCentralDirectoryOffset + 22 + commentLength !== zipBuffer.length) {
    throw new Error('ZIP end-of-central-directory comment length does not match the archive size')
  }

  const entries: ZipEntry[] = []
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    assertBufferRange(zipBuffer, offset, 46, 'central-directory entry')
    if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error('Invalid ZIP central-directory entry')
    }

    const generalPurposeBitFlag = zipBuffer.readUInt16LE(offset + 8)
    const compressionMethod = zipBuffer.readUInt16LE(offset + 10)
    const compressedSize = zipBuffer.readUInt32LE(offset + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24)
    const fileNameLength = zipBuffer.readUInt16LE(offset + 28)
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 30)
    const fileCommentLength = zipBuffer.readUInt16LE(offset + 32)
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42)
    const entrySize = 46 + fileNameLength + extraFieldLength + fileCommentLength

    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
      throw new Error('ZIP64 entries are not supported for release verification')
    }

    if (offset + entrySize > centralDirectoryEnd) {
      throw new Error('ZIP central-directory entry exceeds the declared directory size')
    }

    const name = zipBuffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8')
    entries.push({ name, generalPurposeBitFlag, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    offset += entrySize
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error('ZIP central-directory size does not match its entries')
  }

  return entries
}

function readZipEntry(zipBuffer: Buffer, entry: ZipEntry): Buffer {
  if ((entry.generalPurposeBitFlag & 0x0001) !== 0) {
    throw new Error(`Encrypted ZIP entries are not supported: ${entry.name}`)
  }

  assertBufferRange(zipBuffer, entry.localHeaderOffset, 30, `${entry.name} local header`)
  if (zipBuffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`)
  }

  const localGeneralPurposeBitFlag = zipBuffer.readUInt16LE(entry.localHeaderOffset + 6)
  const localCompressionMethod = zipBuffer.readUInt16LE(entry.localHeaderOffset + 8)
  const fileNameLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26)
  const extraFieldLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28)
  const localFileNameOffset = entry.localHeaderOffset + 30
  assertBufferRange(zipBuffer, localFileNameOffset, fileNameLength, `${entry.name} local file name`)
  const localFileName = zipBuffer.subarray(localFileNameOffset, localFileNameOffset + fileNameLength).toString('utf8')

  if (localFileName !== entry.name) {
    throw new Error(`ZIP local and central entry names differ: ${entry.name}`)
  }

  if (localGeneralPurposeBitFlag !== entry.generalPurposeBitFlag || localCompressionMethod !== entry.compressionMethod) {
    throw new Error(`ZIP local and central headers differ: ${entry.name}`)
  }

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

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function assertSafeZipEntryName(entryName: string): void {
  const pathWithoutDirectorySuffix = entryName.endsWith('/') ? entryName.slice(0, -1) : entryName
  const pathSegments = pathWithoutDirectorySuffix.split('/')

  if (
    !pathWithoutDirectorySuffix
    || entryName.includes('\\')
    || entryName.includes('\0')
    || entryName.startsWith('/')
    || WINDOWS_DRIVE_PREFIX_RE.test(entryName)
    || entryName.includes('//')
    || pathSegments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Installer ZIP contains an unsafe entry name: ${entryName}`)
  }
}

function assertSourceFile(sourcePath: string, label: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`${label} does not exist: ${sourcePath}`)
  }

  const sourceStat = lstatSync(sourcePath)
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`${label} must be a regular file: ${sourcePath}`)
  }
}

function collectExpectedInstallerEntries(projectRoot: string): ExpectedInstallerEntries {
  const sourceManifestPath = resolve(projectRoot, THEME_MANIFEST_FILE)
  const sourcePreviewPath = resolve(projectRoot, 'docs/preview.png')
  const sourceDistPath = resolve(projectRoot, 'dist')

  assertSourceFile(sourceManifestPath, 'Source metadata')
  assertSourceFile(sourcePreviewPath, 'Source preview')

  if (!existsSync(sourceDistPath)) {
    throw new Error(`Source dist/ does not exist: ${sourceDistPath}`)
  }

  const distStat = lstatSync(sourceDistPath)
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
    throw new Error(`Source dist/ must be a regular directory: ${sourceDistPath}`)
  }

  const directories = new Set<string>()
  const files = new Map<string, string>([
    [THEME_MANIFEST_FILE, sourceManifestPath],
    ['preview.png', sourcePreviewPath],
  ])

  const walkDist = (directory: string, zipPrefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = resolve(directory, entry.name)
      const zipEntryName = `${zipPrefix}${entry.name}`

      if (entry.isSymbolicLink()) {
        throw new Error(`Source dist/ must not contain symbolic links: ${sourcePath}`)
      }

      if (entry.isDirectory()) {
        directories.add(`${zipEntryName}/`)
        walkDist(sourcePath, `${zipEntryName}/`)
      }
      else if (entry.isFile()) {
        files.set(zipEntryName, sourcePath)
      }
      else {
        throw new Error(`Source dist/ contains a non-regular entry: ${sourcePath}`)
      }
    }
  }

  walkDist(sourceDistPath, 'dist/')

  if (![...files.keys()].some(entryName => entryName.startsWith('dist/'))) {
    throw new Error('Source dist/ contains no files')
  }

  return { directories, files }
}

function formatEntryList(entryNames: string[]): string {
  const displayedEntries = entryNames.slice(0, 10)
  const remainingCount = entryNames.length - displayedEntries.length
  return `${displayedEntries.join(', ')}${remainingCount > 0 ? `, ... (+${remainingCount})` : ''}`
}

export function verifyInstallerZip(installerPath: string, expectedVersion: string, projectRoot = PROJECT_ROOT): InstallerVerification {
  if (!existsSync(installerPath) || !statSync(installerPath).isFile()) {
    throw new Error(`Expected installer ZIP does not exist: ${installerPath}`)
  }

  const zipBuffer = readFileSync(installerPath)
  const entries = readZipEntries(zipBuffer)
  const actualEntries = new Map<string, ZipEntry>()

  for (const entry of entries) {
    assertSafeZipEntryName(entry.name)
    if (actualEntries.has(entry.name)) {
      throw new Error(`Installer ZIP contains a duplicate entry: ${entry.name}`)
    }
    actualEntries.set(entry.name, entry)
  }

  const expectedEntries = collectExpectedInstallerEntries(projectRoot)
  const expectedEntryNames = new Set([
    ...expectedEntries.directories,
    ...expectedEntries.files.keys(),
  ])
  const actualEntryNames = new Set(actualEntries.keys())
  const missingEntries = [...expectedEntryNames].filter(entryName => !actualEntryNames.has(entryName)).sort()
  const unexpectedEntries = [...actualEntryNames].filter(entryName => !expectedEntryNames.has(entryName)).sort()

  if (missingEntries.length > 0 || unexpectedEntries.length > 0) {
    const mismatchParts = []
    if (missingEntries.length > 0) {
      mismatchParts.push(`missing: ${formatEntryList(missingEntries)}`)
    }
    if (unexpectedEntries.length > 0) {
      mismatchParts.push(`unexpected: ${formatEntryList(unexpectedEntries)}`)
    }
    throw new Error(`Installer ZIP entry set does not match canonical inputs (${mismatchParts.join('; ')})`)
  }

  for (const directoryName of expectedEntries.directories) {
    const directoryEntry = actualEntries.get(directoryName)!
    if (directoryEntry.uncompressedSize !== 0 || readZipEntry(zipBuffer, directoryEntry).length !== 0) {
      throw new Error(`Installer ZIP directory entry contains data: ${directoryName}`)
    }
  }

  for (const [entryName, sourcePath] of expectedEntries.files) {
    const zipEntry = actualEntries.get(entryName)!
    const sourceSize = statSync(sourcePath).size
    if (zipEntry.uncompressedSize !== sourceSize) {
      throw new Error(`Installer ZIP size provenance mismatch for ${entryName}: ZIP ${zipEntry.uncompressedSize}, source ${sourceSize}`)
    }

    const zipEntryHash = sha256(readZipEntry(zipBuffer, zipEntry))
    const sourceHash = sha256(readFileSync(sourcePath))

    if (zipEntryHash !== sourceHash) {
      throw new Error(`Installer ZIP SHA-256 provenance mismatch for ${entryName}: ZIP ${zipEntryHash}, source ${sourceHash}`)
    }
  }

  const rootManifestEntry = actualEntries.get(THEME_MANIFEST_FILE)!
  const zipVersion = readManifestVersionFromBuffer(readZipEntry(zipBuffer, rootManifestEntry), 'Installer ZIP metadata')
  if (zipVersion !== expectedVersion) {
    throw new Error(`Installer ZIP metadata version ${zipVersion} does not match source version ${expectedVersion}`)
  }

  return {
    directoryCount: expectedEntries.directories.size,
    fileCount: expectedEntries.files.size,
    installerSha256: sha256(zipBuffer),
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
  const installerVerification = verifyInstallerZip(releasePaths.installerPath, sourceVersion)
  ensureReleaseWorkspace(PROJECT_ROOT, sourceVersion)
  copyReleaseSnapshot(releasePaths.releaseDirectory)
  verifyReleaseSnapshot(releasePaths.releaseDirectory, sourceVersion)

  console.log(`[release:prepare] Verified installer ZIP: ${releasePaths.installerPath}`)
  console.log(`[release:prepare] Provenance matched ${installerVerification.fileCount} files and ${installerVerification.directoryCount} directories (SHA-256 ${installerVerification.installerSha256})`)
  console.log(`[release:prepare] Created release snapshot: ${releasePaths.releaseDirectory}`)
  console.log(`[release:prepare] Publish snapshot path reserved: ${releasePaths.publishDirectory}`)
  console.log('[release:prepare] Git staging remains manual; keep the installer outside Git and upload this verified ZIP by default as the sole custom Release asset unless this version explicitly opts out.')
}

const invokedScriptPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedScriptPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
