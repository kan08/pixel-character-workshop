import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const profile = process.env.PIXEL_HERMES_PROFILE || 'pixel-workshop';
export const model = 'gpt-6.2-sol';
const command = process.env.PIXEL_HERMES_BIN || join(homedir(), '.local/bin/hermes');
const exec = promisify(execFile);

function rpcClient(socket, signal) {
  let sequence = 0;
  const pending = new Map();
  function fail() {
    for (const request of pending.values()) request.reject(new Error('Hermesとの接続が切れました。'));
    pending.clear();
  }
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error('Hermesが制作ツールからの呼び出しを拒否しました。'));
    else request.resolve(message.result);
  });
  signal.addEventListener('abort', () => socket.close(), { once: true });
  return (method, params) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Hermesとの接続が切れました。'));
      return;
    }
    const id = ++sequence;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    pending.set(id, { resolve, reject });
  });
}

export async function requestCodex(prompt, image) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) throw new Error('Hermesプロファイル名を確認してください。');
  const signal = AbortSignal.timeout(75000);
  const status = await exec(command, ['-p', profile, 'auth', 'status', 'openai-codex'], { timeout: 5000 })
    .catch(() => null);
  if (!status || !/^openai-codex: logged in\b/m.test(status.stdout)) {
    throw new Error(`Hermesの ${profile} でCodexサブスク認証を確認してください。`);
  }
  let raw;
  try {
    ({ stdout: raw } = await exec(command, ['-p', profile, 'gateway', 'attach', '--json'], { timeout: 5000 }));
  } catch {
    throw new Error(`Hermesの ${profile} ゲートウェイに接続できません。`);
  }
  const ticket = JSON.parse(raw);
  const address = new URL(ticket.url);
  if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || address.pathname !== '/api/ws') {
    throw new Error('Hermesのローカル接続先を確認してください。');
  }
  const staging = join(homedir(), '.hermes', 'profiles', profile, 'cache', 'images');
  const file = join(staging, `pixel-workshop-${randomUUID()}.png`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(file, image, { mode: 0o600, flag: 'wx' });
  let socket;
  try {
    socket = new WebSocket(address, ticket.protocols);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Hermesを開けませんでした。')), { once: true });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const rpc = rpcClient(socket, signal);
    const session = await rpc('session.create', {
      request_id: randomUUID(), source: 'tool', provider: 'openai-codex', model,
      safe_mode: true, reasoning: 'low', max_turns: 1, toolsets: [],
    });
    const sessionId = session.stored_session_id;
    const admission = await rpc('prompt.submit', {
      session_id: sessionId, input_id: randomUUID(), text: prompt, finite: true, unattended: true,
      attachments: [{ path: file, mime: 'image/png' }],
    });
    if (!admission?.admission_id) throw new Error('Hermesが画像付きの依頼を受理しませんでした。');
    for (;;) {
      const receipt = await rpc('prompt.receipt', {
        session_id: sessionId, admission_id: admission.admission_id, include_result: true,
      });
      if (receipt.status === 'terminal') {
        if (receipt.outcome !== 'completed' || receipt.result?.failed) {
          const reason = String(receipt.result?.error || receipt.result?.final_response || '');
          if (/401|sign.in|authenticat/i.test(reason)) {
            throw new Error(`Hermesの ${profile} でCodexサブスク認証を確認してください。`);
          }
          throw new Error('HermesのCodex呼び出しが完了しませんでした。');
        }
        if (!receipt.result?.final_response) throw new Error('Codexが修正案を返しませんでした。');
        return receipt.result.final_response;
      }
      if (receipt.status === 'unknown') throw new Error('Hermesの実行結果を確認できませんでした。');
      await delay(600, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) throw new Error('Hermesの応答を75秒以内に確認できませんでした。');
    throw error;
  } finally {
    socket?.close();
    await rm(file, { force: true });
  }
}
