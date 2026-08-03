import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { loadGuidelinesTemplate, resetGuidelinesTemplateCache, validateConventions } from '../../config/index.js';

describe('loadGuidelinesTemplate', () => {
  beforeEach(() => resetGuidelinesTemplateCache());

  it('loads the checked-in template with all structural markers', () => {
    const text = loadGuidelinesTemplate();
    assert.ok(text.includes('{Client}'), 'has the {Client} token');
    assert.ok(text.includes('[TBD:'), 'has [TBD: …] placeholder slots');
    const sections = text.match(/^## \d+\./gm) || [];
    assert.strictEqual(sections.length, 10, 'has exactly 10 numbered sections');
  });

  it('caches after first load', () => {
    const first = loadGuidelinesTemplate();
    const second = loadGuidelinesTemplate();
    assert.strictEqual(first, second);
  });

  it('rejects a template missing its structural markers, listing every problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelup-template-'));
    const path = join(dir, 'bad-template.md');
    writeFileSync(path, '# Some Doc\n\nNo tokens, no sections.\n');
    assert.throws(
      () => loadGuidelinesTemplate({ path }),
      (/** @type {Error} */ e) =>
        e.message.includes('{Client}') && e.message.includes('sections') && e.message.includes('[TBD:'),
    );
  });

  it('an explicit path does not poison the default cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelup-template-'));
    const path = join(dir, 'alt-template.md');
    // Structurally valid but distinct content.
    const sections = Array.from({ length: 10 }, (_, i) => `## ${i + 1}. Section\n\n[TBD: x]\n`).join('\n');
    writeFileSync(path, `# Alt — {Client}\n\n${sections}`);
    const alt = loadGuidelinesTemplate({ path });
    assert.ok(alt.includes('# Alt'));
    const dflt = loadGuidelinesTemplate();
    assert.ok(!dflt.includes('# Alt'), 'default load returns the checked-in template');
  });
});

describe('channels.registration_alert_slack_id validation', () => {
  /** @returns {any} */
  function fixture() {
    return JSON.parse(readFileSync(new URL('../fixtures/conventions.json', import.meta.url), 'utf8'));
  }

  it('accepts a string value', () => {
    const data = fixture();
    data.channels.registration_alert_slack_id = 'U0000000LEAD';
    assert.doesNotThrow(() => validateConventions(data));
  });

  it('accepts the field being absent', () => {
    assert.doesNotThrow(() => validateConventions(fixture()));
  });

  it('rejects a non-string value', () => {
    const data = fixture();
    data.channels.registration_alert_slack_id = 42;
    assert.throws(() => validateConventions(data), /registration_alert_slack_id must be a string/);
  });
});
