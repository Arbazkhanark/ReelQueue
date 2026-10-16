import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '../../../../packages/shared/src/routes';
import { buildPath } from './http';

const SRC = join(__dirname, '..');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('every shared route builds a URL once its :params are supplied', () => {
  for (const [name, spec] of Object.entries(ROUTES)) {
    const params: Record<string, string> = {};
    for (const m of spec.path.matchAll(/:([A-Za-z_]\w*)/g)) params[m[1]!] = 'x1';
    assert.doesNotMatch(buildPath(spec.path, params), /:/, name);
  }
});
test('every route name used via call()/useApi()/invalidate() in src exists in ROUTES', () => {
  const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
  const used = new Map<string, string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b(?:call|useApi|invalidate)\(\s*'([A-Za-z]+)'/g)) used.set(m[1]!, f);
  }
  assert.ok(used.size > 20, `expected many route usages, found ${used.size}`);
  for (const [name, file] of used) assert.ok(name in ROUTES, `${name} (used in ${file}) is not in ROUTES`);
});
test('the contract has every route the pages need (documented gaps live in CONTRACT_GAPS.md)', () => {
  for (const n of ['login', 'register', 'initUpload', 'completeUpload', 'reorderVideos', 'startCycle', 'updateCycle', 'listJobs', 'retryJob', 'adminUsers', 'dashboard']) {
    assert.ok(n in ROUTES, n);
  }
});
