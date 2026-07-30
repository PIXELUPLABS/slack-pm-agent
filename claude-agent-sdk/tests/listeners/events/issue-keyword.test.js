import assert from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));

const { parseIssueKeyword } = await import('../../../listeners/events/message.js');

describe('parseIssueKeyword', () => {
  it('matches the bug and feature keywords with a colon', () => {
    assert.deepStrictEqual(parseIssueKeyword('bug: recap did not post'), {
      kind: 'bug',
      body: 'recap did not post',
    });
    assert.deepStrictEqual(parseIssueKeyword('feature: read Loom links too'), {
      kind: 'feature',
      body: 'read Loom links too',
    });
  });

  it('is case- and whitespace-tolerant, and accepts a dash', () => {
    for (const text of ['Bug: x', 'BUG:   x', '  bug :x', 'bug - x', 'bug — x']) {
      assert.strictEqual(parseIssueKeyword(text)?.kind, 'bug', text);
      assert.strictEqual(parseIssueKeyword(text)?.body, 'x', text);
    }
  });

  it('only matches at the START — a bug mentioned mid-sentence is not a report', () => {
    // This is the collision that matters: QA work on a client's site.
    assert.strictEqual(parseIssueKeyword("there's a bug: the client's nav overlaps"), null);
    assert.strictEqual(parseIssueKeyword('the client found a bug in the footer'), null);
    assert.strictEqual(parseIssueKeyword('add a feature to the acme site'), null);
  });

  it('requires the separator, so ordinary sentences do not trigger', () => {
    assert.strictEqual(parseIssueKeyword('bug reports should go somewhere'), null);
    assert.strictEqual(parseIssueKeyword('feature requests welcome'), null);
  });

  it('handles empty and missing text', () => {
    assert.strictEqual(parseIssueKeyword(''), null);
    assert.strictEqual(parseIssueKeyword(/** @type {any} */ (undefined)), null);
  });

  it('keeps multi-line bodies intact', () => {
    const parsed = parseIssueKeyword('bug: recap missing\nsteps: dropped transcript, waited 5m');
    assert.strictEqual(parsed?.kind, 'bug');
    assert.match(/** @type {string} */ (parsed?.body), /steps: dropped transcript/);
  });
});
