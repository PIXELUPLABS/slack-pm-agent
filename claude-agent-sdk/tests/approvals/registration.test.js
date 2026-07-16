import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { buildRegistration, deriveClientKey, findClientFolder, pickLists } from '../../approvals/registration.js';

const HIERARCHY = {
  children: [
    {
      name: 'Delivery',
      type: 'space',
      children: [
        {
          id: '800001',
          name: 'Marker',
          type: 'folder',
          children: [
            { id: '900001', name: 'Brand and website sprint', type: 'list' },
            { id: '900002', name: 'Web QA Marker', type: 'list' },
          ],
        },
        { id: '800002', name: 'EmptyCo', type: 'folder', children: [] },
      ],
    },
  ],
};

function fakeSlackClient(channels) {
  return {
    conversations: {
      list: mock.fn(async () => ({ channels, response_metadata: {} })),
    },
  };
}

describe('deriveClientKey', () => {
  it('kebab-cases names', () => {
    assert.strictEqual(deriveClientKey('Marker'), 'marker');
    assert.strictEqual(deriveClientKey('Henry Labs'), 'henry-labs');
    assert.strictEqual(deriveClientKey('  Weird -- Name! '), 'weird-name');
  });
});

describe('findClientFolder / pickLists', () => {
  it('finds a folder case-insensitively', () => {
    const match = findClientFolder(HIERARCHY, 'marker');
    assert.strictEqual(match?.folder.id, '800001');
    assert.strictEqual(match?.lists.length, 2);
  });

  it('returns null for unknown folders', () => {
    assert.strictEqual(findClientFolder(HIERARCHY, 'ghost'), null);
  });

  it('splits main and QA lists', () => {
    const { mainList, qaList } = pickLists(findClientFolder(HIERARCHY, 'Marker').lists);
    assert.strictEqual(mainList.id, '900001');
    assert.strictEqual(qaList.id, '900002');
  });
});

describe('buildRegistration', () => {
  const clickup = { getHierarchy: async () => HIERARCHY };

  it('builds a full entry when everything resolves', async () => {
    const slackClient = fakeSlackClient([
      { id: 'CEXT1', name: 'marker-pixelup' },
      { id: 'CINT1', name: 'marker-internal' },
      { id: 'COTHER', name: 'general' },
    ]);
    const { clientKey, entry, notes } = await buildRegistration({ clientName: 'Marker', slackClient, clickup });
    assert.strictEqual(clientKey, 'marker');
    assert.deepStrictEqual(entry, {
      display_name: 'Marker',
      channel_id: 'CEXT1',
      internal_channel_id: 'CINT1',
      list_id: '900001',
      qa_list_id: '900002',
      folder_id: '800001',
    });
    assert.strictEqual(notes.length, 0);
  });

  it('notes missing channels instead of failing', async () => {
    const slackClient = fakeSlackClient([{ id: 'COTHER', name: 'general' }]);
    const { entry, notes } = await buildRegistration({ clientName: 'Marker', slackClient, clickup });
    assert.strictEqual(entry.channel_id, '');
    assert.strictEqual(entry.internal_channel_id, '');
    assert.strictEqual(notes.length, 2);
  });

  it('fails clearly when the ClickUp folder is missing', async () => {
    const slackClient = fakeSlackClient([]);
    await assert.rejects(
      () => buildRegistration({ clientName: 'Ghost', slackClient, clickup }),
      /No ClickUp folder named "Ghost"/,
    );
  });

  it('fails clearly when the folder has no lists', async () => {
    const slackClient = fakeSlackClient([]);
    await assert.rejects(() => buildRegistration({ clientName: 'EmptyCo', slackClient, clickup }), /has no lists yet/);
  });
});
