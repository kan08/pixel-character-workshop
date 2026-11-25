import { adopt, newProject, setBasis } from './project.js';
import { canvas, colorSet } from './images.js';

const colors = {
  ink: '#283048', purple: '#6354a4', violet: '#967bd2', light: '#c9b0f5',
  skin: '#efb68c', cheek: '#c57f77', gold: '#f6cb70', blue: '#599ba6', white: '#fff0ce',
};

// Original 32 × 32 sample, drawn at native resolution to make motion checks reproducible.
function drawSprite(step, blink, extra) {
  const picture = canvas(32, 32);
  const context = picture.getContext('2d');
  const box = (color, x, y, w, h) => {
    context.fillStyle = colors[color];
    context.fillRect(x, y, w, h);
  };
  const bob = Math.abs(step) === 1 ? 1 : 0;
  const body = (color, x, y, w, h) => box(color, x, y - bob, w, h);

  const frontX = { '-2': 9, '-1': 14, 0: 17, 1: 15, 2: 21 }[step];
  const backX = { '-2': 21, '-1': 16, 0: 13, 1: 18, 2: 9 }[step];
  const backY = step === 1 ? 25 : 27;
  const frontY = step === -1 ? 25 : 27;
  box('ink', backX - 1, backY - 1, 6, 4);
  box('blue', backX, backY, 4, 2);
  box('ink', 13, 21 - bob, 10, 5);
  box('purple', 14, 22 - bob, 8, 4);
  box('ink', frontX - 1, frontY - 1, 7, 4);
  box('violet', frontX, frontY, 5, 2);
  box('light', frontX + 3, frontY, 2, 1);

  body('ink', 8, 16, 15, 8);
  body('purple', 9, 17, 13, 6);
  body('violet', 12, 16, 10, 6);
  body('blue', 8, 17, 4, 5);
  body('gold', 15, 18, 6, 2);
  const arm = step === 2 ? 11 : step === -2 ? 18 : 15;
  body('ink', arm, 19, 5, 5);
  body('violet', arm + 1, 19, 3, 3);
  body('skin', arm + 1, 22, 3, 1);
  if (extra) body('white', arm + 1, 20, 1, 2);

  body('ink', 11, 5, 14, 11);
  body('ink', 13, 3, 10, 14);
  body('violet', 13, 5, 10, 4);
  body('light', 15, 4, 6, 2);
  body('purple', 12, 7, 3, 7);
  body('skin', 15, 8, 9, 7);
  body('skin', 22, 11, 4, 3);
  body('cheek', 16, 13, 3, 1);
  body('ink', 21, 10, 2, blink ? 1 : 2);
  body('gold', 12, 10, 2, 2);
  body('purple', 14, 15, 9, 1);
  return picture.toDataURL('image/png');
}

export async function sampleProject() {
  const project = newProject('ルウ');
  const sequence = [
    ['standing', 0, false], ['blink', 0, true], ['right', 2, false],
    ['pass-right', 1, false], ['left', -2, false], ['pass-left', -1, false],
    ['older-right', 2, false, true],
  ];
  for (const [id, step, blink, extra] of sequence) {
    project.images[id] = { name: `${id}.png`, width: 32, height: 32, url: drawSprite(step, blink, extra) };
  }
  setBasis(project, { ...project.basis, imageId: 'standing', palette: await colorSet(project.images['older-right']) });
  const frame = (imageId, ms, pose) => ({ imageId, ms, pose });
  project.clips.idle.frames = [frame('standing', 620, 'idle'), frame('blink', 100, 'idle')];
  adopt(project, 'idle', 'まばたきの差分');
  project.clips.walk.frames = [
    frame('older-right', 120, 'right-contact'), frame('pass-right', 110, 'passing'),
    frame('left', 120, 'left-contact'), frame('pass-left', 110, 'passing'),
  ];
  adopt(project, 'walk', '袖のハイライトがある試作');
  project.clips.walk.frames[0].imageId = 'right';
  adopt(project, 'walk', '袖のハイライトを除いた版');
  return project;
}
