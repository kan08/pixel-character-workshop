import {
  adopt, clipIssues, frameLimit, framesEqual, maxDuration, minDuration, motions,
  newProject, parseProject, planExport, poses, restore, setBasis,
} from './project.js';
import { bitmapFor, canvas, colorSet, imageIssues, pixelDiff, prepareRecolor, readPng, toPngBlob } from './images.js';
import { sampleProject } from './sample.js';

const tabs = {
  basis: '基準画', poses: 'キーポーズ', frames: 'コマ制作',
  compare: '比較・採用', export: '検品・出力',
};
const tabIds = Object.keys(tabs);
const workspace = document.getElementById('workspace');
const tabBar = document.getElementById('tabs');
const status = document.getElementById('status');
const fileInput = document.getElementById('file');

let project = newProject();
let tab = 'frames';
let motion = 'walk';
let frameIndex = 0;
let archiveId = null;
let fileAction;
let dirty = false;
let busy = false;
let playing = false;
let playbackRequest = 0;
let playStarted = 0;
let displayFrame = 0;
let nativeSize = false;
let lightBackground = false;
let drawVersion = 0;
let checked = null;
let diffVersion = 0;
let candidate = null;
let spriteBounds = null;

const currentClip = () => project.clips[motion];
const selectedFrame = () => currentClip().frames[frameIndex];
const imageFor = frame => frame ? project.images[frame.imageId] : null;
const basisImage = () => project.images[project.basis.imageId];
const oldRevision = () => currentClip().revisions.find(revision => revision.id === archiveId)
  ?? currentClip().revisions.at(-2) ?? currentClip().revisions.at(-1);
const esc = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const button = (label, action, options = '') => `<button type="button" data-action="${action}" ${options}>${label}</button>`;
const thumb = image => image ? `<img src="${image.url}" alt="">` : '<span class="muted">未設定</span>';
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const number = (name, value, min, max) => `<input name="${name}" type="number" min="${min}" max="${max}" value="${value}" required>`;
const options = (values, selected) => Object.entries(values).map(([value, label]) =>
  `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');

function announce(message, error = false) {
  status.textContent = message;
  status.classList.toggle('warning', error);
}

function changed() {
  dirty = true;
  checked = null;
  render();
}

function setProject(next) {
  project = next;
  candidate = null;
  motion = 'walk';
  frameIndex = 0;
  archiveId = null;
  playing = false;
  dirty = false;
  checked = null;
  tab = basisImage() ? 'frames' : 'basis';
  render();
}

function clipState(key) {
  const { frames, revisions } = project.clips[key];
  const last = revisions.at(-1);
  return !frames.length ? '空' : last?.basisVersion === project.basisVersion && framesEqual(last.frames, frames)
    ? '採用済み' : '編集中';
}

function renderBasis() {
  const { width, height, x, y, direction, palette, binaryAlpha } = project.basis;
  return `<form class="panel-content" data-form="basis">
    ${button('基準画のPNGを取り込む', 'basis-import')}
    ${field('キャラ名', `<input name="name" value="${esc(project.name)}" maxlength="80" required>`)}
    <p>枠 ${width} × ${height}px</p>
    <div class="fields">${field('足元 X', number('x', x, 0, width - 1))}${field('足元 Y', number('y', y, 0, height - 1))}</div>
    ${field('向き', `<select name="direction">${options({ right: '右向き', left: '左向き' }, direction)}</select>`)}
    <label class="checkbox"><input type="checkbox" name="binaryAlpha" ${binaryAlpha ? 'checked' : ''}>二値透過を検査する</label>
    ${field('共通パレット（空欄で色制限なし）', `<textarea name="palette" rows="2" spellcheck="false">${palette.join(' ')}</textarea>`)}
    <button class="primary">基準設定を適用</button>
  </form>`;
}

function renderPoses() {
  const cards = ['right-contact', 'left-contact'].map(pose => {
    const index = project.clips.walk.frames.findIndex(item => item.pose === pose);
    const view = thumb(imageFor(project.clips.walk.frames[index]));
    const content = `${view}<span>${poses[pose]}</span>`;
    return index < 0 ? `<div class="small-image">${content}</div>`
      : button(content, 'jump-pose', `class="small-image" data-index="${index}"`);
  }).join('');
  return `<div class="panel-content"><p>右足前と左足前の絵を並べ、どちらの足が前か確かめます。</p>
    <div class="comparison">${cards}</div>
    ${motion === 'walk' && selectedFrame() ? poseField() : '<p>歩きのコマを取り込み、選択してください。</p>'}
  </div>`;
}

function poseField() {
  const frame = selectedFrame();
  return field('選択コマの姿勢', `<select data-change="pose">${options(poses, frame.pose)}</select>`);
}

function renderFrames() {
  const frame = selectedFrame();
  const count = currentClip().frames.length;
  return `<div class="panel-content">${button('PNGコマを追加', 'frames-import', 'class="primary"')}
    ${frame ? `<p>${frameIndex + 1} / ${count} · ${esc(imageFor(frame).name)}</p>
      ${poseField()}
      ${field('表示時間（ms）', `<input type="number" data-change="duration" value="${frame.ms}" min="${minDuration}" max="${maxDuration}" required>`)}
      <div class="actions">
        ${button('前へ', 'frame-earlier', frameIndex === 0 ? 'disabled' : '')}
        ${button('後ろへ', 'frame-later', frameIndex === count - 1 ? 'disabled' : '')}
      </div>
      <div class="actions">${button('差し替え', 'frame-replace')}${button('コマを外す', 'frame-remove')}</div>
      ${renderRecolor(frame)}` : '<p>同じ寸法のPNGを、再生順に追加してください。</p>'}
    </div>`;
}

function activeCandidate() {
  const frame = selectedFrame();
  return candidate?.frame === frame && candidate?.sourceId === frame?.imageId
    && candidate?.basisVersion === project.basisVersion ? candidate : null;
}

function renderRecolor(frame) {
  const image = imageFor(frame);
  const draft = activeCandidate();
  const { x, y, width, height } = draft?.area ?? { x: 0, y: 0, width: 1, height: 1 };
  return `<details ${draft ? 'open' : ''}>
    <summary>AIで部分修正</summary>
    <form class="field" data-form="recolor">
      <p>プレビューをクリックすると開始位置を選べます。範囲内の不透明な画素を共通パレットで塗り替える候補を作ります。</p>
      <div class="fields">
        ${field('開始 X', number('x', x, 0, image.width - 1))}
        ${field('開始 Y', number('y', y, 0, image.height - 1))}
        ${field('幅', number('width', width, 1, Math.min(12, image.width)))}
        ${field('高さ', number('height', height, 1, Math.min(12, image.height)))}
      </div>
      ${field('修正の指示', `<textarea name="instruction" rows="2" maxlength="300" required>${esc(draft?.instruction ?? '')}</textarea>`)}
      <button type="submit">候補を生成</button>
    </form>
    ${draft ? `<div class="comparison">
      <div class="small-image">${thumb(image)}<span>現在</span></div>
      <div class="small-image">${thumb(draft.image)}<span>候補</span></div>
    </div>
    <p>${draft.changes}画素の差分 · ${esc(draft.model)}</p>
    <div class="actions">${button('候補を下書きに反映', 'apply-recolor')}${button('候補を閉じる', 'dismiss-recolor')}</div>` : ''}
  </details>`;
}

async function generateRecolor(values) {
  const frame = selectedFrame();
  const source = imageFor(frame);
  const area = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(values.get(key))]));
  const instruction = values.get('instruction').trim();
  if (!instruction) throw new Error('修正の指示を入力してください。');
  const palette = project.basis.palette.length ? project.basis.palette : await colorSet(source);
  if (palette.length < 2 || palette.length > 256) throw new Error('2〜256色の共通パレットを設定してください。');
  const patch = await prepareRecolor(source, area);
  announce('ローカルのOllamaで候補を生成しています。');
  const response = await fetch('/api/pixel-edits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: area.width, height: area.height, cells: patch.cells, palette, instruction }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  const image = patch.apply(result.edits, palette);
  const changes = await pixelDiff(source, image);
  if (changes !== result.edits.length) throw new Error('候補の変更が指定範囲の画素と一致しませんでした。');
  candidate = { frame, sourceId: frame.imageId, basisVersion: project.basisVersion,
    image, changes, area, instruction, model: result.model };
  render();
  announce('候補を生成しました。元のコマと見比べてください。');
}

function applyRecolor() {
  const draft = activeCandidate();
  if (!draft) throw new Error('このコマの候補を生成してください。');
  const { image, sourceId, area, instruction, model } = draft;
  const next = { ...image, name: 'AI修正候補.png', generation: { sourceId, area, instruction, model } };
  draft.frame.imageId = addImage(next);
  candidate = null;
  changed();
  announce('候補を下書きに反映しました。比較・採用タブで確認してください。');
}

function renderCompare() {
  const frame = selectedFrame();
  const revision = oldRevision();
  const archived = revision?.frames[frameIndex];
  const available = Object.fromEntries(currentClip().revisions.map(item => [item.id, `第${item.id}版${item.note ? ' · ' + item.note : ''}`]));
  const issues = clipIssues(project, motion, currentClip().frames);
  return `<div class="panel-content">
    ${revision ? field('比較する履歴', `<select data-change="archive">${options(available, revision.id)}</select>`) : '<p>採用した版はここで比較できます。</p>'}
    <div class="comparison"><div class="small-image">${thumb(imageFor(archived))}<span>履歴のコマ</span></div>
    <div class="small-image">${thumb(imageFor(frame))}<span>現在のコマ</span></div></div>
    <p id="pixel-diff"></p>
    ${revision ? button('この版を下書きに戻す', 'restore') : ''}
    ${issues.length ? `<ul class="check-list warning">${issues.map(issue => `<li>${issue}</li>`).join('')}</ul>` : ''}
    <form class="field" data-form="adopt">
      ${field('採用メモ', '<textarea name="note" rows="2" maxlength="500"></textarea>')}
      <button class="primary" ${issues.length ? 'disabled' : ''}>現在のコマを採用</button>
    </form>
  </div>`;
}

function renderExport() {
  let attempt;
  try { attempt = planExport(project); } catch (error) { return `<div class="panel-content"><p class="warning">${esc(error.message)}</p></div>`; }
  const total = Object.values(attempt.animations).reduce((sum, item) => sum + item.frames.length, 0);
  const messages = checked?.issues ?? [];
  return `<div class="panel-content">
    <p>${attempt.width} × ${attempt.height}px · ${total}コマ</p>
    <p>移動プレビューで床と足の位置を確認できます。</p>
    ${button('画像とシートを検査', 'validate')}
    ${messages.length ? `<ul class="check-list warning">${messages.map(message => `<li>${esc(message)}</li>`).join('')}</ul>`
      : checked ? '<p class="ok">画像とシートの検査に合格しました。</p>' : '<p>PNGとJSONは合格した構成から出力します。</p>'}
    ${button('シートPNGを保存', 'export-png', 'class="primary"')}
    ${button('コマ情報JSONを保存', 'export-json')}
  </div>`;
}

const inspectors = { basis: renderBasis, poses: renderPoses, frames: renderFrames, compare: renderCompare, export: renderExport };

const playLabel = () => playing ? '停止' : tab === 'export' && motion === 'walk' ? '移動プレビューを再生' : '再生';

function render() {
  spriteBounds = null;
  document.getElementById('project-name').textContent = project.name;
  const { width, height, x, y } = project.basis;
  document.getElementById('project-spec').textContent = `${width} × ${height}px　·　足元 (${x}, ${y})${dirty ? '　·　未保存の変更あり' : ''}`;
  tabBar.innerHTML = `<div class="tablist" role="tablist">${tabIds.map(id => button(tabs[id], 'tab',
    `id="tab-${id}" role="tab" data-id="${id}" aria-selected="${tab === id}" aria-controls="step-panel" tabindex="${tab === id ? 0 : -1}"`)).join('')}</div>`;
  const frames = currentClip().frames;
  const showTimeline = tab !== 'basis';
  const tools = `${button(nativeSize ? '拡大表示' : '原寸表示', 'size')}
    ${button(lightBackground ? '暗い背景' : '明るい背景', 'background')}`;
  workspace.innerHTML = `
    <section class="panel"><div class="panel-header"><h3>動作</h3></div><div class="motion-list">
      ${Object.entries(motions).map(([key, label]) => button(
        `${label}<span>${clipState(key)}</span>`, 'motion', `data-id="${key}" aria-pressed="${motion === key}"`)).join('')}
    </div></section>
    <section class="panel" aria-label="スプライトのプレビュー">
      <div class="panel-header"><h3>${tab === 'basis' ? '基準画プレビュー' : `${motions[motion]}プレビュー`}</h3><div class="preview-tools">${tools}</div></div>
      <div class="stage ${lightBackground ? 'light' : ''}"><canvas id="preview" aria-label="キャラクター表示"></canvas>
        ${!(tab === 'basis' ? basisImage() : selectedFrame()) ? '<p class="empty-stage">PNGを取り込むと、ここに表示されます。</p>' : ''}</div>
      ${showTimeline ? `<div class="transport"><div class="actions">${button(playLabel(), 'play', `id="play-button" ${frames.length ? '' : 'disabled'}`)}</div>
      <span id="play-counter"></span></div><div class="filmstrip" aria-label="コマ一覧">
        ${frames.map((frame, index) => button(
          `${thumb(imageFor(frame))}<small>${index + 1} · ${frame.ms}ms</small>`, 'frame',
          `class="frame" data-index="${index}" aria-pressed="${frameIndex === index}" aria-label="${index + 1}コマ目 ${poses[frame.pose]}"`)).join('')}
        ${frames.length ? '' : '<p class="muted">コマがありません。</p>'}</div>` : ''}
    </section>
    <section class="panel" id="step-panel" role="tabpanel" aria-labelledby="tab-${tab}">
      <div class="panel-header"><h3>${tabs[tab]}</h3></div>${inspectors[tab]()}
    </section>`;
  paint(frameIndex, 0);
  if (tab === 'compare') showDiff();
}

async function showDiff() {
  const marker = ++diffVersion;
  const element = document.getElementById('pixel-diff');
  const before = imageFor(oldRevision()?.frames[frameIndex]);
  const after = imageFor(selectedFrame());
  if (!before || !after) return;
  try {
    const count = await pixelDiff(before, after);
    if (marker === diffVersion) element.textContent = count === null ? '寸法が異なるため比較できません。' : `差分 ${count}画素`;
  } catch (error) {
    if (marker === diffVersion) element.textContent = error.message;
  }
}

async function paint(index, displacement) {
  const version = ++drawVersion;
  const preview = document.getElementById('preview');
  if (!preview) return;
  const frame = currentClip().frames[index];
  const image = tab === 'basis' ? basisImage() : imageFor(frame);
  const basis = project.basis;
  const zoom = nativeSize ? 1 : Math.max(1, Math.floor(Math.min(160 / basis.width, 160 / basis.height)));
  const width = Math.max(320, basis.width * zoom + 32);
  const height = Math.max(244, basis.height * zoom + 32);
  const floor = Math.floor(height / 2 + (basis.y - basis.height / 2) * zoom);
  const bitmap = image ? await bitmapFor(image).catch(() => null) : null;
  if (version !== drawVersion || !preview.isConnected) return;
  if (preview.width !== width) preview.width = width;
  if (preview.height !== height) preview.height = height;
  const context = preview.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = false;
  if (tab === 'export' || tab === 'basis') {
    context.fillStyle = lightBackground ? '#b2a8a4' : '#504956';
    context.fillRect(16, floor, width - 32, 1);
    if (tab === 'export') {
      for (let tick = 20; tick < width - 16; tick += 20) context.fillRect(tick, floor + 1, 1, 5);
    }
  }
  if (bitmap) {
    const offset = basis.direction === 'left' ? -displacement : displacement;
    const left = Math.floor((width - bitmap.width * zoom) / 2) + offset;
    const top = Math.floor((height - bitmap.height * zoom) / 2);
    spriteBounds = { left, top, zoom, width: bitmap.width, height: bitmap.height };
    context.drawImage(bitmap, left, top, bitmap.width * zoom, bitmap.height * zoom);
    const form = workspace.querySelector('details[open] form[data-form="recolor"]');
    preview.classList.toggle('pick-area', Boolean(form) && !playing);
    if (form && !playing) {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(key => form.elements.namedItem(key).valueAsNumber);
      if ([x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0
        && x + w <= bitmap.width && y + h <= bitmap.height) {
        context.strokeStyle = '#c8b6fb';
        context.strokeRect(left + x * zoom + .5, top + y * zoom + .5, w * zoom, h * zoom);
      }
    }
    if (tab === 'basis') {
      context.fillStyle = '#d9b9ff';
      context.fillRect(left + basis.x * zoom, floor - 4, 1, 9);
    }
  }
  const counter = document.getElementById('play-counter');
  if (counter) counter.textContent = frame ? `${index + 1} / ${currentClip().frames.length}　${poses[frame.pose]}　·　${zoom}倍` : '';
  workspace.querySelectorAll('.frame').forEach((element, position) => element.classList.toggle('playing', playing && position === index));
}

function playback(now) {
  if (!playing) return;
  const frames = currentClip().frames;
  const period = frames.reduce((sum, frame) => sum + frame.ms, 0);
  if (!period) { stopPlayback(); return; }
  const time = (now - playStarted) % period;
  let index = 0;
  let end = frames[0].ms;
  while (index < frames.length - 1 && time >= end) end += frames[++index].ms;
  const moving = tab === 'export' && motion === 'walk';
  if (moving || displayFrame !== index) paint(index, moving ? Math.floor(((now - playStarted) / 12) % 120) - 60 : 0);
  displayFrame = index;
  playbackRequest = requestAnimationFrame(playback);
}

function stopPlayback() {
  playing = false;
  cancelAnimationFrame(playbackRequest);
  const play = document.getElementById('play-button');
  if (play) play.textContent = playLabel();
  paint(frameIndex, 0);
}

function togglePlayback() {
  if (playing) { stopPlayback(); return; }
  playing = true;
  displayFrame = -1;
  playStarted = performance.now();
  document.getElementById('play-button').textContent = '停止';
  playbackRequest = requestAnimationFrame(playback);
}

function choose(action, accept, multiple = false) {
  fileAction = action;
  fileInput.accept = accept;
  fileInput.multiple = multiple;
  fileInput.value = '';
  fileInput.click();
}

function addImage(image) {
  const id = crypto.randomUUID();
  project.images[id] = image;
  return id;
}

async function importFiles(action, files) {
  if (!files.length) return;
  if (action === 'open') {
    if (files[0].size > 64 * 1024 * 1024) throw new Error('64MBまでのプロジェクトを開けます。');
    const next = parseProject(await files[0].text());
    for (const image of Object.values(next.images)) await bitmapFor(image);
    setProject(next);
    announce('プロジェクトを開きました。');
    return;
  }
  const images = [];
  if (files.length > frameLimit || (action === 'frames-import' && currentClip().frames.length + files.length > frameLimit)) {
    throw new Error(`1動作につき${frameLimit}コマまでです。`);
  }
  for (const file of files) images.push(await readPng(file));
  const first = images[0];
  if (action === 'basis-import') {
    const palette = await colorSet(first);
    const imageId = addImage(first);
    setBasis(project, { ...project.basis, imageId, width: first.width, height: first.height,
      x: Math.floor(first.width / 2), y: first.height - 1, palette: palette.length <= 256 ? palette : [] });
    changed();
    announce('基準画を取り込みました。足元位置とパレットを確認してください。');
    return;
  }
  const frames = currentClip().frames;
  if (!basisImage()) throw new Error('先に基準画を取り込んでください。');
  if (images.some(image => image.width !== project.basis.width || image.height !== project.basis.height)) {
    throw new Error(`すべてのコマを基準画と同じ ${project.basis.width} × ${project.basis.height}px にしてください。`);
  }
  if (action === 'frame-replace') {
    const current = selectedFrame();
    if (!current) throw new Error('差し替えるコマを選んでください。');
    current.imageId = addImage(first);
  } else {
    frameIndex = frames.length;
    frames.push(...images.map(image => ({ imageId: addImage(image), pose: motion === 'idle' ? 'idle' : 'other', ms: 120 })));
  }
  changed();
  announce(`${images.length}枚のPNGを取り込みました。`);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filenameBase() {
  return project.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'sprite';
}
const jsonBlob = data => new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });

async function inspectExport() {
  if (checked) return checked;
  const plan = planExport(project);
  const ids = new Set([project.basis.imageId]);
  Object.values(plan.animations).forEach(item => item.frames.forEach(frame => ids.add(frame.imageId)));
  const issues = [];
  for (const id of ids) {
    const image = project.images[id];
    for (const issue of await imageIssues(image, project.basis)) issues.push(`${image.name} · ${issue}`);
  }
  checked = { plan, issues };
  return checked;
}

async function exportFile(type) {
  const { plan, issues } = await inspectExport();
  render();
  if (issues.length) throw new Error('画像の検査結果を確認してください。');
  const base = filenameBase();
  if (type === 'json') {
    download(jsonBlob({ ...plan, image: `${base}.png` }), `${base}.json`);
  } else {
    const sheet = canvas(plan.width, plan.height);
    const context = sheet.getContext('2d');
    for (const clip of Object.values(plan.animations)) {
      for (const frame of clip.frames) {
        context.drawImage(await bitmapFor(project.images[frame.imageId]), frame.rect.x, frame.rect.y);
      }
    }
    download(await toPngBlob(sheet), `${base}.png`);
  }
  announce(`${type.toUpperCase()}のダウンロードを開始しました。`);
}

async function task(operation) {
  if (busy) return;
  busy = true;
  try { await operation(); }
  catch (error) { announce(error.message || '操作を完了できませんでした。', true); }
  finally { busy = false; }
}

function selectTab(id, focus = false) {
  stopPlayback();
  tab = id;
  render();
  stopPlayback();
  if (focus) document.getElementById(`tab-${tab}`).focus();
}

function selectMotion(id) {
  stopPlayback();
  motion = id;
  frameIndex = 0;
  archiveId = null;
  render();
  stopPlayback();
}

function moveFrame(step) {
  const frames = currentClip().frames;
  const target = frameIndex + step;
  if (!frames[target]) return;
  [frames[frameIndex], frames[target]] = [frames[target], frames[frameIndex]];
  frameIndex = target;
  changed();
}

function resetAllowed() { return !dirty || window.confirm('未保存の変更があります。別のプロジェクトを開きますか？'); }

const actions = {
  new: () => { if (resetAllowed()) { setProject(newProject()); announce('新規プロジェクトを開きました。'); } },
  sample: async () => { if (resetAllowed()) { setProject(await sampleProject()); announce('サンプルを開きました。'); } },
  open: () => { if (resetAllowed()) choose('open', '.json,application/json'); },
  save: () => {
    const blob = jsonBlob(project);
    if (blob.size > 64 * 1024 * 1024) throw new Error('64MBを超えるため保存できません。');
    download(blob, `${filenameBase()}.pixel-project.json`);
    dirty = false;
    render();
    announce('プロジェクトのダウンロードを開始しました。');
  },
  tab: element => selectTab(element.dataset.id, true),
  motion: element => selectMotion(element.dataset.id),
  size: () => { nativeSize = !nativeSize; render(); },
  background: () => { lightBackground = !lightBackground; render(); },
  play: togglePlayback,
  frame: element => { stopPlayback(); frameIndex = Number(element.dataset.index); render(); },
  'jump-pose': element => { selectMotion('walk'); frameIndex = Number(element.dataset.index); render(); },
  'basis-import': () => choose('basis-import', '.png,image/png'),
  'frames-import': () => choose('frames-import', '.png,image/png', true),
  'frame-replace': () => choose('frame-replace', '.png,image/png'),
  'frame-remove': () => {
    const frames = currentClip().frames;
    frames.splice(frameIndex, 1);
    frameIndex = Math.max(0, Math.min(frameIndex, frames.length - 1));
    changed();
  },
  'frame-earlier': () => moveFrame(-1),
  'frame-later': () => moveFrame(1),
  'apply-recolor': applyRecolor,
  'dismiss-recolor': () => { candidate = null; render(); },
  restore: () => { restore(project, motion, oldRevision().id); frameIndex = 0; changed(); announce('履歴の内容を下書きに戻しました。'); },
  validate: async () => { const result = await inspectExport(); render(); announce(result.issues.length ? '検査で修正箇所が見つかりました。' : '画像とシートの検査に合格しました。', Boolean(result.issues.length)); },
  'export-png': () => exportFile('png'),
  'export-json': () => exportFile('json'),
};

document.addEventListener('click', event => {
  const buttonEl = event.target.closest('[data-action]');
  if (!buttonEl || buttonEl.disabled) return;
  const action = buttonEl.dataset.action;
  if (!['play', 'size', 'background'].includes(action)) stopPlayback();
  task(() => actions[action](buttonEl));
});

workspace.addEventListener('click', event => {
  if (event.target.id !== 'preview' || !spriteBounds || playing || busy) return;
  const form = workspace.querySelector('details[open] form[data-form="recolor"]');
  if (!form) return;
  const preview = event.target;
  const bounds = preview.getBoundingClientRect();
  const { left, top, zoom, width, height } = spriteBounds;
  const x = Math.floor(((event.clientX - bounds.left) * preview.width / bounds.width - left) / zoom);
  const y = Math.floor(((event.clientY - bounds.top) * preview.height / bounds.height - top) / zoom);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  form.elements.namedItem('x').value = x;
  form.elements.namedItem('y').value = y;
  paint(frameIndex, 0);
});
workspace.addEventListener('input', event => {
  if (event.target.type === 'number' && event.target.form?.dataset.form === 'recolor') paint(frameIndex, 0);
});
workspace.addEventListener('toggle', event => {
  if (event.target.querySelector('form[data-form="recolor"]')) paint(frameIndex, 0);
}, true);

document.addEventListener('keydown', event => {
  if (busy || event.target.getAttribute('role') !== 'tab') return;
  let index = tabIds.indexOf(tab);
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = tabIds.length - 1;
  else if (event.key === 'ArrowLeft') index = (index + tabIds.length - 1) % tabIds.length;
  else if (event.key === 'ArrowRight') index = (index + 1) % tabIds.length;
  else return;
  event.preventDefault();
  selectTab(tabIds[index], true);
});

fileInput.addEventListener('change', () => task(() => importFiles(fileAction, [...fileInput.files])));

document.addEventListener('change', event => {
  const field = event.target;
  if (!field.dataset.change || busy) return;
  stopPlayback();
  task(() => {
    if (field.dataset.change === 'archive') { archiveId = Number(field.value); render(); return; }
    const frame = selectedFrame();
    if (field.dataset.change === 'duration') {
      if (!field.checkValidity()) { field.reportValidity(); field.value = frame.ms; return; }
      frame.ms = Number(field.value);
    } else {
      frame.pose = field.value;
    }
    changed();
  });
});

document.addEventListener('submit', event => {
  if (!event.target.dataset.form) return;
  event.preventDefault();
  const values = new FormData(event.target);
  stopPlayback();
  task(() => {
    if (event.target.dataset.form === 'recolor') return generateRecolor(values);
    if (event.target.dataset.form === 'adopt') {
      adopt(project, motion, values.get('note'));
      changed();
      announce(`${motions[motion]}の第${currentClip().revisions.length}版を採用しました。`);
      return;
    }
    const name = values.get('name').trim();
    if (!name) throw new Error('キャラ名を入力してください。');
    const palette = [...new Set(values.get('palette').toLowerCase().split(/[\s,]+/).filter(Boolean))];
    setBasis(project, { ...project.basis, x: Number(values.get('x')), y: Number(values.get('y')),
      direction: values.get('direction'), palette, binaryAlpha: values.has('binaryAlpha') });
    project.name = name;
    changed();
    announce('基準設定を適用しました。変更した設定では動作の採用を確認してください。');
  });
});

window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});

render();
await task(async () => {
  setProject(await sampleProject());
  announce('サンプルを表示しています。');
});
