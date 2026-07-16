import assert from 'node:assert';
import { describe, it } from 'node:test';

import { shouldRun, zonedParts } from '../../schedules/client-updates.js';

describe('zonedParts', () => {
  it('resolves wall-clock parts in UTC', () => {
    // 2026-07-14 is a Tuesday.
    const parts = zonedParts(new Date('2026-07-14T09:05:00Z'), 'UTC');
    assert.strictEqual(parts.weekday, 'tuesday');
    assert.strictEqual(parts.hour, 9);
    assert.strictEqual(parts.minute, 5);
    assert.strictEqual(parts.dateKey, '2026-07-14');
  });

  it('respects the timezone', () => {
    // 09:00 UTC is 05:00 in New York (EDT, July, UTC-4).
    const parts = zonedParts(new Date('2026-07-14T09:00:00Z'), 'America/New_York');
    assert.strictEqual(parts.hour, 5);
  });
});

describe('shouldRun', () => {
  const schedule = { enabled: true, days: ['tuesday', 'friday'], hour: 9, minute: 0 };
  const tuesdayNine = { weekday: 'tuesday', hour: 9, minute: 0, dateKey: '2026-07-14' };

  it('fires on a scheduled day at the scheduled minute', () => {
    assert.strictEqual(shouldRun(tuesdayNine, schedule, null), true);
  });

  it('never fires when disabled', () => {
    assert.strictEqual(shouldRun(tuesdayNine, { ...schedule, enabled: false }, null), false);
  });

  it('does not fire twice for the same day', () => {
    assert.strictEqual(shouldRun(tuesdayNine, schedule, '2026-07-14'), false);
  });

  it('fires again on the next scheduled day', () => {
    const fridayNine = { weekday: 'friday', hour: 9, minute: 0, dateKey: '2026-07-17' };
    assert.strictEqual(shouldRun(fridayNine, schedule, '2026-07-14'), true);
  });

  it('skips wrong days and wrong minutes', () => {
    assert.strictEqual(shouldRun({ ...tuesdayNine, weekday: 'monday' }, schedule, null), false);
    assert.strictEqual(shouldRun({ ...tuesdayNine, minute: 1 }, schedule, null), false);
    assert.strictEqual(shouldRun({ ...tuesdayNine, hour: 10 }, schedule, null), false);
  });
});
