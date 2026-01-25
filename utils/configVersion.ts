import fs from 'fs';
import path from 'path';

type Versions = { compose?: string; normalize?: string };
let cached: Versions | null = null;

function readVersionFromYaml(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const m = text.match(/\bconfig_version:\s*"?(\d+\.\d+\.\d+)"?/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export function getConfigVersions(projectRoot?: string): Versions {
  if (cached) return cached;
  const base = projectRoot || path.resolve(__dirname, '..');
  const cfgDir = path.resolve(base, 'config');
  const composePath = path.resolve(cfgDir, 'compose_detection.yaml');
  const normalizePath = path.resolve(cfgDir, 'normalize.yaml');
  const compose = readVersionFromYaml(composePath);
  const normalize = readVersionFromYaml(normalizePath);
  cached = { compose, normalize };
  return cached;
}

