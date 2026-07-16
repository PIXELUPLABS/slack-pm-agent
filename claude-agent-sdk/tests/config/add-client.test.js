import assert from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { addClientToConventions, loadConventions, resetConventionsCache } from '../../config/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'conventions-write-'));
const tempPath = join(tempDir, 'conventions.json');
const fixturePath = new URL('../fixtures/conventions.json', import.meta.url).pathname;

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CONVENTIONS_PATH;
});

describe('addClientToConventions', () => {
  beforeEach(() => {
    copyFileSync(fixturePath, tempPath);
    process.env.CONVENTIONS_PATH = tempPath;
    resetConventionsCache();
  });

  const entry = {
    display_name: 'Marker',
    channel_id: 'CEXT1',
    internal_channel_id: 'CINT1',
    list_id: '900001',
    qa_list_id: '',
    folder_id: '800001',
  };

  it('writes the client and hot-reloads the cache', () => {
    const conventions = addClientToConventions('marker', entry);
    assert.strictEqual(conventions.clients.marker.display_name, 'Marker');
    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(tempPath, 'utf8'));
    assert.strictEqual(onDisk.clients.marker.list_id, '900001');
    // Cache reloaded — a fresh load sees it without force
    assert.ok(loadConventions().clients.marker);
  });

  it('refuses duplicates', () => {
    addClientToConventions('marker', entry);
    assert.throws(() => addClientToConventions('marker', entry), /already exists/);
  });

  it('validates the entry before writing', () => {
    assert.throws(
      () => addClientToConventions('bad', /** @type {any} */ ({ display_name: 'Bad' })),
      /conventions\.json is invalid/,
    );
    // Nothing was persisted
    const onDisk = JSON.parse(readFileSync(tempPath, 'utf8'));
    assert.strictEqual(onDisk.clients.bad, undefined);
  });
});
