import assert from 'node:assert/strict';
import test from 'node:test';
import { generateEdits, validateEdits } from '../pixel-model.mjs';

const input = { cells: ['#283048', null, '#efb68c'], palette: ['#283048', '#efb68c'], editable: [0, 2] };

test('model edits preserve transparent cells and use only allowed colors and positions', () => {
  assert.deepEqual(validateEdits([{ cell: 0, color: 1 }, { cell: 2, color: 1 }], input), [{ cell: 0, color: 1 }]);
  for (const invalid of [[{ cell: 1, color: 1 }], [{ cell: 3, color: 1 }], [{ cell: 0, color: 2 }],
    [{ cell: 0, color: 1 }, { cell: 0, color: 0 }]]) {
    assert.throws(() => validateEdits(invalid, input), /条件を外れました/);
  }
  assert.throws(() => validateEdits([{ cell: 0, color: 0 }], input), /提案しませんでした/);
});

test('invalid dimensions fail before contacting Hermes', async () => {
  const result = await generateEdits({ width: 13, height: 1, cells: [], palette: [], instruction: 'test' });
  assert.equal(result.status, 400);
});
