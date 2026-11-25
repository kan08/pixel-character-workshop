import { model, requestCodex } from './hermes-codex.mjs';
const validColor = color => typeof color === 'string' && /^#[\da-f]{6}$/.test(color);
const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateInput(input) {
  const { width, height, cells, palette, instruction, image } = input ?? {};
  if (!isInteger(width, 1, 12) || !isInteger(height, 1, 12)
    || !Array.isArray(cells) || cells.length !== width * height
    || !Array.isArray(palette) || palette.length < 2 || palette.length > 256
    || !palette.every(validColor) || new Set(palette).size !== palette.length
    || !cells.every(color => color === null || validColor(color))
    || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 300
    || typeof image !== 'string' || image.length > 2_000_000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw new Error('編集範囲、パレットと指示を確認してください。');
  }
  const imageBytes = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
  if (!imageBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('対象コマはPNG画像で送ってください。');
  }
  const editable = cells.flatMap((color, index) => color === null ? [] : [index]);
  if (!editable.length) throw new Error('編集範囲に不透明な画素がありません。');
  return { width, height, cells, palette, instruction: instruction.trim(), editable, imageBytes };
}

export function validateEdits(edits, input) {
  const { cells, palette, editable } = input;
  if (!Array.isArray(edits) || edits.length > Math.min(24, editable.length)) {
    throw new Error('モデルの提案が画素数の上限を超えています。範囲を絞って再試行してください。');
  }
  const seen = new Set();
  for (const edit of edits) {
    if (!editable.includes(edit?.cell) || !isInteger(edit?.color, 0, palette.length - 1) || seen.has(edit.cell)) {
      throw new Error('モデルが編集範囲やパレットの条件を外れました。範囲を絞って再試行してください。');
    }
    seen.add(edit.cell);
  }
  const changed = edits.filter(edit => cells[edit.cell] !== palette[edit.color]);
  if (!changed.length) throw new Error('モデルは変更できる色を提案しませんでした。指示や範囲を変えてください。');
  return changed;
}

export async function generateEdits(raw) {
  let input;
  try { input = validateInput(raw); } catch (error) { return { status: 400, error: error.message }; }
  const { width, height, editable, palette, cells, instruction } = input;
  const grid = Array.from({length: height}, (_, y) => cells.slice(y * width, (y + 1) * width)
    .map((color, x) => `${y * width + x}=${color ?? 'protected'}`).join(' ')).join('\n');
  const prompt = [
    'Inspect the attached full pixel-art frame for context. Propose edits for only the selected patch.',
    'Recolor only the listed editable cells. Use each cell at most once and only a palette index. Use at most 24 edits.',
    'Do not call tools. Return plain JSON only, using {"edits":[{"cell":0,"color":1}]} for shape. If no edit helps, return {"edits":[]}.',
    `Palette index=hex: ${palette.map((value, index) => `${index}=${value}`).join(' ')}`,
    `Editable cell IDs: ${editable.join(', ')}`,
    `Selected patch, one line per row:\n${grid}`,
    `Requested edit: ${instruction}`,
  ].join('\n');
  let result;
  try {
    result = await requestCodex(prompt, input.imageBytes);
  } catch (error) {
    return { status: 503, error: error.message };
  }
  try {
    const edits = validateEdits(JSON.parse(result.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')).edits, input);
    return { status: 200, model, edits };
  } catch (error) {
    return { status: 422, error: error instanceof SyntaxError ? 'モデルの応答を読めませんでした。範囲を絞って再試行してください。' : error.message };
  }
}
