import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const THEME_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Z.-]+)?$/i

export interface ReleasePaths {
  version: string
  versionDirectory: string
  publishDirectory: string
  releaseDirectory: string
  installerFileName: string
  installerPath: string
}

function normalizeVersion(version: string): string {
  const normalizedVersion = version.trim()

  if (!THEME_VERSION_RE.test(normalizedVersion)) {
    throw new Error(`Invalid theme version for release paths: ${version}`)
  }

  return normalizedVersion
}

/**
 * Keep every generated release artifact outside the source repository, grouped
 * below one directory named after the manifest version.
 */
export function getReleasePaths(projectRoot: string, version: string): ReleasePaths {
  const normalizedVersion = normalizeVersion(version)
  const versionDirectory = resolve(projectRoot, '..', normalizedVersion)

  return {
    version: normalizedVersion,
    versionDirectory,
    publishDirectory: resolve(versionDirectory, `Glassmorphism-Plus-publish-${normalizedVersion}`),
    releaseDirectory: resolve(versionDirectory, `Glassmorphism-Plus-release-${normalizedVersion}`),
    installerFileName: `Glassmorphism-Plus-release-${normalizedVersion}.zip`,
    installerPath: resolve(versionDirectory, `Glassmorphism-Plus-release-${normalizedVersion}.zip`),
  }
}

/**
 * Create only the version workspace. Publish and release snapshots are made by
 * the release process later, so a normal build never creates placeholder copies.
 */
export function ensureReleaseWorkspace(projectRoot: string, version: string): ReleasePaths {
  const releasePaths = getReleasePaths(projectRoot, version)
  mkdirSync(releasePaths.versionDirectory, { recursive: true })
  return releasePaths
}
