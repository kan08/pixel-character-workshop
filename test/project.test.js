import assert from 'node:assert/strict';
import test from 'node:test';
import { adopt, newProject, parseProject, planExport, restore, setBasis } from '../public/project.js';

function fixture() {
  const project = newProject('動作テスト');
  for (const id of ['body', 'left', 'right']) {
    project.images[id] = { name: `${id}.png`, width: 32, height: 32, url: 'data:image/png;base64,AAAA' };
  }
  setBasis(project, { ...project.basis, imageId: 'body' });
  project.clips.idle.frames = [{ imageId: 'body', pose: 'idle', ms: 600 }];
  project.clips.walk.frames = [
    { imageId: 'right', pose: 'right-contact', ms: 120 },
    { imageId: 'left', pose: 'left-contact', ms: 110 },
  ];
  return project;
}

test('export uses adopted snapshots and packs frame rectangles without overlap', () => {
  const project = fixture();
  adopt(project, 'idle', '待機');
  adopt(project, 'walk', '右・左');
  const plan = planExport(project);
  assert.deepEqual([plan.width, plan.height], [96, 32]);
  assert.deepEqual(plan.pivot, { x: 16, y: 29 });
  assert.deepEqual(plan.animations.walk.frames.map(frame => [frame.rect.x, frame.rect.y, frame.ms]), [[32, 0, 120], [64, 0, 110]]);
  project.clips.walk.frames[0].ms = 140;
  assert.equal(project.clips.walk.revisions[0].frames[0].ms, 120);
  assert.throws(() => planExport(project), /歩き.*採用/);
  restore(project, 'walk', 1);
  assert.equal(planExport(project).animations.walk.frames[0].ms, 120);
});

test('a changed basis invalidates adoption without altering its history', () => {
  const project = fixture();
  adopt(project, 'idle', '');
  adopt(project, 'walk', '');
  setBasis(project, { ...project.basis, x: 15 });
  assert.throws(() => planExport(project), /待機.*採用/);
  assert.equal(project.clips.walk.revisions.length, 1);
  adopt(project, 'idle', '');
  adopt(project, 'walk', '');
  assert.equal(planExport(project).pivot.x, 15);
});

test('walk requires both contacts and cannot adopt mismatched dimensions', () => {
  const project = fixture();
  project.clips.walk.frames[1].pose = 'passing';
  assert.throws(() => adopt(project, 'walk', ''), /左足前/);
  project.clips.walk.frames[1].pose = 'left-contact';
  project.images.left.width = 16;
  assert.throws(() => adopt(project, 'walk', ''), /寸法/);
  assert.equal(project.clips.walk.revisions.length, 0);
});

test('a saved form round trips and rejects broken references and unsupported schemas', () => {
  const project = fixture();
  adopt(project, 'walk', '保存されるメモ');
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
  delete project.images.left;
  assert.throws(() => parseProject(JSON.stringify(project)), /参照/);
  assert.throws(() => parseProject('{"schema":2}'), /形式/);
});
