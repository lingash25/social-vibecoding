'use strict';

// #5123 (compliance plan AI-02): every request the platform sends to
// OpenRouter carries `provider.data_collection: "deny"`, so neither the first
// host nor any fallback (`allow_fallbacks`) can be one that trains on or keeps
// the prompt. One helper adds it (worker/openrouter-privacy.js). These pin:
//   - the helper: it keeps every other routing field and overrides an "allow";
//   - the call sites: each module that posts a model request to OpenRouter is
//     driven with a fake fetch, and every body it sends (fallback resends and
//     token counts included) is checked;
//   - the walk: every file that names an OpenRouter base or inference path is
//     either one of those senders or says why it sends no model request, so a
//     new call site fails here until it is covered.
//
// Run with: node --test tests/openrouter-no-training.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const privacy = require('../worker/openrouter-privacy');

function assertDenied(body, where) {
  assert.ok(body && typeof body === 'object', `${where}: a JSON body`);
  assert.equal(body.provider?.data_collection, 'deny', `${where}: provider.data_collection must be "deny"`);
}

// ── The helper ──────────────────────────────────────────────────────────

test('the helper denies data collection and keeps every other routing field', () => {
  assert.equal(privacy.DATA_COLLECTION, 'deny');
  const asked = {
    order: ['fireworks', 'together'], only: ['fireworks'], ignore: ['wafer'], sort: 'throughput',
    allow_fallbacks: true, require_parameters: true, zdr: true,
  };
  assert.deepEqual(privacy.noTrainingProvider(asked), { ...asked, data_collection: 'deny' });
  assert.deepEqual(Object.keys(privacy.noTrainingProvider(asked)), [...Object.keys(asked), 'data_collection'],
    'the order of the fields asked for is kept');
  assert.equal(asked.data_collection, undefined, 'the object passed in is not changed');
  for (const nothing of [undefined, null, 'allow', [], 7]) {
    assert.deepEqual(privacy.noTrainingProvider(nothing), { data_collection: 'deny' }, JSON.stringify(nothing));
  }
});

test('an "allow" from anywhere upstream never survives', () => {
  assert.deepEqual(
    privacy.noTrainingProvider({ data_collection: 'allow', allow_fallbacks: true }),
    { data_collection: 'deny', allow_fallbacks: true },
  );
  const body = { model: 'm', messages: [], provider: { data_collection: 'allow', order: ['a'] } };
  assert.deepEqual(privacy.withNoTraining(body), {
    model: 'm', messages: [], provider: { data_collection: 'deny', order: ['a'] },
  });
  assert.equal(body.provider.data_collection, 'allow', 'the caller\'s body is not mutated');
  assert.deepEqual(privacy.withNoTraining({ model: 'm' }), { model: 'm', provider: { data_collection: 'deny' } });
});

// ── The call sites ──────────────────────────────────────────────────────

test('the shared transport (model helpers, translation, small changes, the bot) denies it', async () => {
  const transport = require('../src/services/openrouter');
  assertDenied(transport.buildRequest({ model: 'z-ai/glm-5.3-flash', reasoning: 'low', messages: [], tools: [] }), 'buildRequest');
  const sent = [];
  await transport.streamChat({
    apiKey: 'k', baseUrl: 'https://openrouter.example/api/v1', model: 'z-ai/glm-5.3-flash', reasoning: 'low',
    messages: [{ role: 'user', content: 'hi' }], tools: [],
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        id: 'gen-1', model: 'z-ai/glm-5.3-flash',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/chat\/completions$/);
  assertDenied(sent[0].body, 'openrouter.js streamChat');
  assert.equal(sent[0].body.provider.allow_fallbacks, true, 'fallbacks stay on, now only among hosts that do not train');
  assert.equal(sent[0].body.provider.sort, 'latency');
});

test('the Mayor\'s client denies it on the first send and on the shortlist\'s resend', async () => {
  const mayor = require('../src/services/openrouter-mayor');
  for (const model of ['anthropic/claude-opus-5.5', 'deepseek/deepseek-v4.1-flash-1017']) {
    const sent = [];
    const client = mayor.createClient({
      apiKey: 'k', model,
      fetchImpl: async (url, init) => {
        sent.push(JSON.parse(init.body));
        const ok = sent.length > 1 || model.startsWith('anthropic/');
        return {
          ok, status: ok ? 200 : 503,
          text: async () => JSON.stringify(ok ? {
            id: 'gen-1', model,
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          } : { error: { message: 'busy' } }),
        };
      },
    });
    await client.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(sent.length, model.startsWith('anthropic/') ? 1 : 2, model);
    sent.forEach((body, i) => assertDenied(body, `${model} send ${i + 1}`));
  }
});

function wav(seconds = 1) {
  const rate = 16000;
  const frames = rate * seconds;
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0, 'ascii'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8, 'ascii');
  data.write('fmt ', 12, 'ascii'); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36, 'ascii'); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 13) * 6000), 44 + i * 2);
  return data;
}

test('dictation denies it on the recording it sends', async () => {
  const { transcribe } = require('../src/services/dictation');
  const sent = [];
  await transcribe({
    data: wav(), apiKey: 'k', config: {},
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/audio\/transcriptions$/);
  assertDenied(sent[0].body, 'dictation');
});

test('a Codex coding turn\'s listener denies it, over an "allow" Codex sent, on the send and the resend', async (t) => {
  const { startRequestAdapter } = require('../worker/codex-openrouter-request');
  const model = 'z-ai/glm-5.3-flash';
  const sent = [];
  const adapter = await startRequestAdapter({
    baseUrl: 'https://openrouter.example/api/v1', apiKey: 'local-key', model, maxOutputTokens: 1000,
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1
        ? new Response('{"error":{"message":"No allowed providers","code":404}}', { status: 404 })
        : new Response('{"id":"response-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => adapter.close());
  const reply = await fetch(`${adapter.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [], provider: { data_collection: 'allow' } }),
  });
  assert.equal(reply.status, 200);
  assert.equal(sent.length, 2, 'the shortlist refused, so the request went once more to every host');
  sent.forEach((body, i) => assertDenied(body, `codex send ${i + 1}`));
  assert.deepEqual(sent[0].provider.only, ['relace', 'fireworks', 'parasail', 'together', 'baseten'],
    'the shortlist is kept beside the deny');
  // Routing Codex brings of its own is kept too.
  sent.length = 0;
  await fetch(`${adapter.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [], provider: { order: ['fireworks'], allow_fallbacks: false } }),
  });
  assert.equal(sent.at(-1).provider.data_collection, 'deny');
  assert.deepEqual(sent.at(-1).provider.order, ['fireworks']);
  assert.equal(sent.at(-1).provider.allow_fallbacks, false);
});

test('a Claude Code coding turn\'s listener denies it, over an "allow", on messages, the resend and token counts', async (t) => {
  const { startMessagesAdapter } = require('../worker/claude-openrouter-request');
  const model = 'z-ai/glm-5.3-flash';
  const sent = [];
  const adapter = await startMessagesAdapter({
    baseUrl: 'https://openrouter.example/api/v1', apiKey: 'k', model, localToken: 'local-token',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      if (sent.length === 1) return new Response('{"error":{"message":"busy","code":503}}', { status: 503 });
      return new Response(url.endsWith('/count_tokens') ? '{"input_tokens":3}'
        : '{"id":"msg-1","type":"message","usage":{"input_tokens":3,"output_tokens":1}}',
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => adapter.close());
  const post = (pathname) => fetch(`${adapter.baseUrl}${pathname}`, {
    method: 'POST', headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [], provider: { data_collection: 'allow' } }),
  });
  assert.equal((await post('/v1/messages')).status, 200);
  assert.equal((await post('/v1/messages/count_tokens')).status, 200);
  assert.deepEqual(sent.map((s) => new URL(s.url).pathname), [
    '/api/v1/messages', '/api/v1/messages', '/api/v1/messages/count_tokens',
  ]);
  sent.forEach((s, i) => assertDenied(s.body, `claude send ${i + 1} (${s.url})`));
});

test('Homeroom bot\'s pictures deny it (bot-pictures.js askImage)', async () => {
  const pictures = require('../src/services/bot-pictures');
  assertDenied(pictures.buildImageRequest({ model: 'google/gemini-2.5-flash-image', prompt: 'A pear' }), 'buildImageRequest');
  const sent = [];
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
  await pictures.askImage({
    apiKey: 'k', baseUrl: 'https://openrouter.example/api/v1', model: 'google/gemini-2.5-flash-image', prompt: 'A pear',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] } }],
        usage: { cost: 0.039 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/chat\/completions$/);
  assertDenied(sent[0].body, 'bot-pictures.js askImage');
});

// ── The walk ────────────────────────────────────────────────────────────
//
// Every file under src/, worker/ and scripts/ (and server.js) that names an
// OpenRouter base or one of its inference paths. A SENDER posts a model
// request itself and must take the helper; every other file says why it
// sends none. A file in neither list fails, so a new call site is a decision.

const OPENROUTER_REFERENCE = /openrouterApiBase|OPENROUTER_API_BASE|openrouter\.ai\/api|\/chat\/completions|\/audio\/(?:transcriptions|speech)|\/embeddings\b|\/images\/generations|\/completions['"`]|upstreamBase\}\/responses/;

const SENDERS = new Map([
  ['src/services/openrouter.js', 'POST /chat/completions for llm.js helpers, translation, small changes and the bot'],
  ['src/services/openrouter-mayor.js', 'POST /chat/completions for the Mayor, bot review and the bot\'s OpenRouter turns'],
  ['src/services/dictation.js', 'POST /audio/transcriptions'],
  ['src/services/bot-pictures.js', 'POST /chat/completions for Homeroom bot\'s pictures (an image-output model)'],
  ['worker/codex-openrouter-request.js', 'POST /responses for every Codex coding turn'],
  ['worker/claude-openrouter-request.js', 'POST /messages and /messages/count_tokens for every Claude Code OpenRouter turn'],
]);

const NOT_SENDERS = new Map([
  ['src/agents/codex-openrouter.js', 'writes Codex\'s config.toml; Codex reaches OpenRouter only through worker/codex-openrouter-request.js'],
  ['src/config.js', 'reads the base URL'],
  ['src/routes/credentials.js', 'validates a key (GET /key)'],
  ['src/services/account-deletion-cleanup.js', 'OpenRouter\'s key management API, no model request'],
  ['src/services/agent-models.js', 'reads the model catalog (GET /models)'],
  ['src/services/agent-turn.js', 'hands the base to the worker, whose listeners send'],
  ['src/services/bot-review.js', 'sends through openrouter-mayor.js'],
  ['src/services/homeroom-bot-mayor.js', 'sends through openrouter.js and openrouter-mayor.js'],
  ['src/services/llm.js', 'sends through openrouter.js'],
  ['src/services/model-costs.js', 'names the catalog URL in a comment'],
  ['src/services/openrouter-managed-keys.js', 'OpenRouter\'s key management API, no model request'],
  ['src/services/small-change.js', 'sends through openrouter.js'],
  ['src/services/worker.js', 'hands the base to the worker, whose listeners send'],
  ['worker/run-cc.sh', 'starts claude only through worker/claude-openrouter-request.js'],
  ['worker/run-codex-agent.sh', 'starts codex only through worker/codex-openrouter-request.js'],
]);

function listFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(?:c|m)?js$|\.ts$|\.sh$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ['src', 'worker', 'scripts']) walk(dir);
  out.push('server.js');
  return out;
}

test('every file that names OpenRouter\'s API is a covered sender or says why it sends no model request', () => {
  const found = listFiles().filter((rel) => OPENROUTER_REFERENCE.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  const unclassified = found.filter((rel) => !SENDERS.has(rel) && !NOT_SENDERS.has(rel));
  assert.deepEqual(unclassified, [],
    'a new file reaches OpenRouter: if it posts a model request, send its body through '
    + 'worker/openrouter-privacy.js and add it to SENDERS with a call-site test; otherwise add it to NOT_SENDERS');
  for (const rel of SENDERS.keys()) {
    assert.ok(found.includes(rel), `${rel} is still found by the walk`);
    assert.match(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /require\((['"])[./]+(?:worker\/)?openrouter-privacy\1\)/,
      `${rel} takes the helper`);
  }
  for (const rel of NOT_SENDERS.keys()) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} still exists; drop it from NOT_SENDERS`);
  }
});

test('the coding CLIs reach OpenRouter only through the listeners that deny it', () => {
  const codexRunner = fs.readFileSync(path.join(ROOT, 'worker/run-codex-agent.sh'), 'utf8');
  const starts = codexRunner.match(/^\s*start_codex .*$/gm) || [];
  assert.ok(starts.length > 0);
  for (const line of starts) assert.match(line, /start_codex node "\$CODEX_REQUEST_WRAPPER"/, line.trim());
  const claudeRunner = fs.readFileSync(path.join(ROOT, 'worker/run-cc.sh'), 'utf8');
  assert.match(claudeRunner, /if \[ "\$AGENT_PROVIDER" = "openrouter" \]; then\n\s*OPENROUTER_API_KEY="\$OPENROUTER_TURN_KEY" node "\$\(dirname "\$0"\)\/claude-openrouter-request\.js"/);
  // The worker image copies the helper beside the listeners that require it.
  const dockerfile = fs.readFileSync(path.join(ROOT, 'worker/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY openrouter-privacy\.js \/usr\/local\/bin\/openrouter-privacy\.js$/m);
});

test('the app-facing LLM proxy forwards to Anthropic only, so no app can reach OpenRouter through it', () => {
  // USERNODE_LLM_PROXY_URL (src/routes/app-llm-proxy.js) is the one model
  // route an app's own code can call. It forwards to Anthropic's Messages API,
  // where OpenRouter's provider routing does not exist. Should it ever forward
  // to OpenRouter, it becomes a SENDER above and must override an app's
  // `provider` with the helper.
  const { ANTHROPIC_UPSTREAM } = require('../src/services/anthropic-stream');
  assert.equal(ANTHROPIC_UPSTREAM, 'https://api.anthropic.com');
  const proxy = fs.readFileSync(path.join(ROOT, 'src/routes/app-llm-proxy.js'), 'utf8');
  assert.match(proxy, /const upstreamUrl = `\$\{anthropicStream\.ANTHROPIC_UPSTREAM\}\/\$\{upstreamPathRaw\}`;/);
  assert.doesNotMatch(proxy, /openrouter/i);
});

test('31 Oct 2026: a retry leaves out the providers that failed it, by slug, and still denies data collection', () => {
  const transport = require('../src/services/openrouter');
  const base = { model: 'z-ai/glm-5.3-flash', reasoning: 'low', messages: [], tools: [] };
  const away = transport.buildRequest({ ...base, ignoreProviders: ['Together', 'Inference.net', 'Together', '', null] });
  assert.deepEqual(away.provider.ignore, ['together', 'inference-net']);
  assertDenied(away, 'buildRequest with ignoreProviders');
  assert.equal(away.provider.sort, 'latency', 'the rest of the routing is kept');
  assert.equal('ignore' in transport.buildRequest(base).provider, false, 'nothing left out unless asked');
  assert.equal(transport.providerSlug('Google AI Studio'), 'google-ai-studio');
  assert.equal(transport.providerSlug('deepinfra/turbo'), 'deepinfra/turbo');
  assert.equal(transport.providerSlug('!!!'), null);
});
