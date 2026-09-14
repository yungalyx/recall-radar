// Drive the real voice path end to end: our server mints the AssemblyAI token, then we push
// PCM16 @16 kHz mono over the WebSocket exactly as the browser's AudioWorklet does, and read the
// Turn messages back. Unit tests cannot tell you the audio format is right; this can.
//
//   sox speech.ogg -r 16000 -c 1 -b 16 -e signed-integer -t raw speech.raw
//   ASSEMBLYAI_API_KEY=... node scripts/voice-smoke.mjs speech.raw
//
// Finding that paid for it: AssemblyAI returns *formatted* text -- "Details one." not "details 1"
// -- which broke every follow-up command until src/intent.js learned to read spoken numbers.
import { readFileSync } from 'node:fs';
import { start } from '../src/server.js';

const s = await start({ port: 0, dbPath: ':memory:' });
const tok = await (await fetch(`${s.base}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('alexa-plus:dev-secret').toString('base64') },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
})).json();

const r = await fetch(`${s.base}/stt-token`, { headers: { authorization: `Bearer ${tok.access_token}` } });
console.log('/stt-token ->', r.status);
const { token } = await r.json();

const pcm = readFileSync(process.argv[2] || '/tmp/speech.raw');
const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true&token=${encodeURIComponent(token)}`);
const turns = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'Begin') console.log('Begin: session', m.id);
  if (m.type === 'Turn') {
    turns.push(m);
    console.log(`Turn end_of_turn=${m.end_of_turn} formatted=${m.turn_is_formatted} :: ${JSON.stringify(m.transcript)}`);
  }
  if (m.type === 'Termination') console.log('Termination:', m.audio_duration_seconds, 's audio');
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

const CHUNK = 3200; // 100 ms of 16-bit 16 kHz mono, same cadence as the worklet
for (let i = 0; i < pcm.length; i += CHUNK) {
  ws.send(pcm.subarray(i, i + CHUNK));
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 3000));
ws.send(JSON.stringify({ type: 'Terminate' }));
await new Promise((r) => setTimeout(r, 1500));

const final = turns.filter((t) => t.end_of_turn && t.turn_is_formatted).map((t) => t.transcript);
console.log('\nFORMATTED FINAL TURNS:', JSON.stringify(final));
console.log(final.length ? 'PASS — the browser audio format is accepted and turns come back formatted' : 'FAIL — no formatted final turn');
await s.close();
process.exit(final.length ? 0 : 1);
