/**
 * @file 音声の対話の単体テスト。見本の相手（偽の Gemini Live）を立てて確かめる。
 *
 * 送った音がそのまま提供者へ渡ること、聞こえた文字と応答が届くこと、
 * 読み上げを切ると音声を求めないこと、録音をどこにも書き出さないことを見る。
 *
 * @see 仕様書 第10.5.5節、ADR-0018
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { GeminiLiveProvider, MockVoiceProvider, type VoiceEvent } from '../src/index.js';

/** 偽の Gemini Live。受け取ったメッセージを覚え、決まった応答を返す。 */
async function fakeLive(): Promise<{
  url: string; received: unknown[]; reply(payload: unknown): void; close(): Promise<void>;
}> {
  const received: unknown[] = [];
  let socket: WsSocket | null = null;
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.on('listening', resolve));
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      received.push(message);
      if (message['setup']) ws.send(JSON.stringify({ setupComplete: {} }));
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    reply: (payload) => socket?.send(JSON.stringify(payload)),
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

const collect = () => {
  const events: VoiceEvent[] = [];
  return { events, onEvent: (e: VoiceEvent) => events.push(e) };
};

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), '待っても届きませんでした');
};

test('音声を送り、聞こえた文字と応答と音を受け取る', async () => {
  const live = await fakeLive();
  const sink = collect();
  const provider = new GeminiLiveProvider({ apiKey: 'test-key', model: 'gemini-live', url: live.url });
  const session = await provider.open({ instructions: 'あなたは秘書です。', speak: true, onEvent: sink.onEvent });

  // 送りは Gemini Live の形（realtimeInput）に直される。中継と画面はこの形を知らない
  session.sendAudio(new Uint8Array([1, 2, 3, 4]));
  await waitFor(() => live.received.length >= 2);
  const sent = live.received[1] as { realtimeInput?: { mediaChunks?: { mimeType?: string; data?: string }[] } };
  assert.match(sent.realtimeInput?.mediaChunks?.[0]?.mimeType ?? '', /audio\/pcm;rate=16000/);
  assert.equal(Buffer.from(sent.realtimeInput?.mediaChunks?.[0]?.data ?? '', 'base64').length, 4);

  live.reply({ serverContent: { inputTranscription: { text: '今日の予定は' } } });
  live.reply({ serverContent: { outputTranscription: { text: '10 時から定例です' } } });
  live.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: Buffer.from([9, 9]).toString('base64') } }] }, turnComplete: true } });
  await waitFor(() => sink.events.some((e) => e.type === 'turn-end'));

  assert.deepEqual(
    sink.events.filter((e) => e.type === 'heard' || e.type === 'reply'),
    [{ type: 'heard', text: '今日の予定は' }, { type: 'reply', text: '10 時から定例です' }],
  );
  const audio = sink.events.find((e) => e.type === 'audio');
  assert.deepEqual(audio && 'pcm' in audio ? [...audio.pcm] : null, [9, 9]);

  session.close();
  await live.close();
});

test('読み上げを切ると、音声を求めず、音も渡さない（第10.5.5節）', async () => {
  const live = await fakeLive();
  const sink = collect();
  const provider = new GeminiLiveProvider({ apiKey: 'test-key', model: 'gemini-live', url: live.url });
  const session = await provider.open({ instructions: '秘書です。', speak: false, onEvent: sink.onEvent });

  const setup = live.received[0] as { setup?: { generationConfig?: { responseModalities?: string[] } } };
  assert.deepEqual(setup.setup?.generationConfig?.responseModalities, ['TEXT']);

  live.reply({ serverContent: { modelTurn: { parts: [{ text: '承知しました' }, { inlineData: { data: Buffer.from([1]).toString('base64') } }] } } });
  await waitFor(() => sink.events.some((e) => e.type === 'reply'));
  assert.equal(sink.events.some((e) => e.type === 'audio'), false, '切っている人に音を渡さない');

  session.close();
  await live.close();
});

test('聞こえた文字と応答を必ず受け取る設定で開く（画面への併記のため）', async () => {
  const live = await fakeLive();
  const sink = collect();
  const provider = new GeminiLiveProvider({ apiKey: 'k', model: 'models/gemini-live', url: live.url });
  const session = await provider.open({ instructions: '秘書です。', speak: true, onEvent: sink.onEvent });
  const setup = live.received[0] as {
    setup?: { model?: string; inputAudioTranscription?: unknown; outputAudioTranscription?: unknown; systemInstruction?: unknown };
  };
  assert.equal(setup.setup?.model, 'models/gemini-live', 'models/ を二重に付けない');
  assert.ok(setup.setup?.inputAudioTranscription);
  assert.ok(setup.setup?.outputAudioTranscription);
  assert.ok(setup.setup?.systemInstruction);
  session.close();
  await live.close();
});

test('鍵が無い環境の見本は、音声を返さず文字だけを返す', async () => {
  const sink = collect();
  const session = await new MockVoiceProvider().open({ instructions: '', speak: true, onEvent: sink.onEvent });
  session.sendText('今日の予定は');
  assert.deepEqual(sink.events.map((e) => e.type), ['heard', 'reply', 'turn-end']);
  assert.equal(sink.events.some((e) => e.type === 'audio'), false, 'それらしい音声を作らない');
  const reply = sink.events.find((e) => e.type === 'reply');
  assert.match(reply && 'text' in reply ? reply.text : '', /見本の応答/);
  session.close();
});

test('選んだ声を提供者へ渡す。選ばなければ既定に任せる（第10.5.6節）', async () => {
  const live = await fakeLive();
  const provider = new GeminiLiveProvider({ apiKey: 'k', model: 'gemini-live', url: live.url });

  const chosen = await provider.open({
    instructions: '秘書です。話し方の指定: 関西弁で話して', speak: true, voice: 'Charon', onEvent: () => undefined,
  });
  const setup = live.received[0] as {
    setup?: { speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } } }; systemInstruction?: { parts?: { text?: string }[] } };
  };
  assert.equal(setup.setup?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, 'Charon');
  assert.match(setup.setup?.systemInstruction?.parts?.[0]?.text ?? '', /関西弁で話して/, '話し方の指示は指示文で渡す');
  chosen.close();

  live.received.length = 0;
  const auto = await provider.open({ instructions: '秘書です。', speak: true, voice: '', onEvent: () => undefined });
  const plain = live.received[0] as { setup?: { speechConfig?: unknown } };
  assert.equal(plain.setup?.speechConfig, undefined, '選ばなければ声を指定しない');
  auto.close();

  live.received.length = 0;
  const silent = await provider.open({ instructions: '秘書です。', speak: false, voice: 'Kore', onEvent: () => undefined });
  const noSpeak = live.received[0] as { setup?: { speechConfig?: unknown } };
  assert.equal(noSpeak.setup?.speechConfig, undefined, '読み上げを切っていれば声も指定しない');
  silent.close();

  await live.close();
});

test('見本は、受け取った声と話し方の指示を答えに書き添える', async () => {
  const sink = collect();
  const session = await new MockVoiceProvider().open({
    instructions: '秘書です。話し方の指定: 関西弁で話して', speak: true, voice: 'Puck', onEvent: sink.onEvent,
  });
  session.sendText('今日の予定は');
  const reply = sink.events.find((e) => e.type === 'reply');
  assert.match(reply && 'text' in reply ? reply.text : '', /声「Puck」と話し方の指示を受け取りました/);
  session.close();
});

test('内部の指示は、利用者の発言として扱わない（仕様書 第10.11.7節）', async () => {
  const sink = collect();
  const session = await new MockVoiceProvider().open({ instructions: '', speak: true, onEvent: sink.onEvent });

  session.sendSystemNote('（内部情報）調べものが終わりました。売上は 300 円です。');
  // 聞こえた文字には出さない。利用者はそう言っていない
  assert.equal(sink.events.some((e) => e.type === 'heard'), false);
  assert.deepEqual(sink.events.map((e) => e.type), ['reply', 'turn-end']);
  session.close();
});

test('内部の指示も 1 往復として送る（Gemini Live）', async () => {
  const live = await fakeLive();
  const provider = new GeminiLiveProvider({ apiKey: 'k', model: 'models/gemini-live', url: live.url });
  const session = await provider.open({ instructions: '', speak: true, onEvent: () => undefined });

  session.sendSystemNote('（内部情報）調べものが終わりました。');
  // 届くまで待つ
  for (let i = 0; i < 50 && live.received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  const sent = live.received.at(-1) as {
    clientContent?: { turns?: { parts?: { text?: string }[] }[]; turnComplete?: boolean };
  };
  assert.match(sent.clientContent?.turns?.[0]?.parts?.[0]?.text ?? '', /内部情報/);
  assert.equal(sent.clientContent?.turnComplete, true, '1 往復として閉じる');
  session.close();
  await live.close();
});
