'use strict';

// Minimal OpenRouter Chat Completions transport, shared by the model
// helpers (llm.js), small changes, translation and the Homeroom bot. It
// accepts only server-built messages and strict tools, asks OpenRouter for
// the lowest-latency compatible provider, and returns a bounded
// OpenAI-compatible assistant message plus content-free usage facts.

const { platformHeaders } = require('./openrouter-client');
// #5123: every OpenRouter request denies data collection (worker/openrouter-privacy.js).
const { noTrainingProvider, withNoTraining } = require('../../worker/openrouter-privacy');
const { REASONING_EFFORT_SET } = require('./reasoning-efforts');

// A caller may make more than one short tool-planning call in one answer.
// Letting any single provider request occupy the UI for 90 seconds made a
// transient failure look like a frozen application and multiplied badly with
// retries.
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
// Homeroom bot parity, P1: room for a long, structured answer (the bot's
// chat asks for 4000, and 8000 once a reply was cut off at its limit).
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 80;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 512 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 256 * 1024;

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// 31 Oct 2026: a provider a caller asks the route to leave out (`ignore`),
// by its slug. A response names its provider ("Together", "Inference.net");
// providerSlug turns that into the slug the routing takes ("together",
// "inference-net"). At most this many on one request.
const PROVIDER_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,40}(?:\/[a-z0-9._-]{1,40})?$/;
const MAX_IGNORED_PROVIDERS = 8;

class OpenRouterProviderError extends Error {
  constructor(code, message, {
    status = null,
    dispatched = false,
    provider = null,
    generationId = null,
    timings = null,
    retryAfterMs = null,
  } = {}) {
    super(message);
    this.name = 'OpenRouterProviderError';
    this.code = code;
    this.status = status;
    this.dispatched = dispatched;
    this.provider = provider;
    this.generationId = generationId;
    this.timings = timings;
    // A refusal's Retry-After, in milliseconds, when it sent one.
    this.retryAfterMs = retryAfterMs;
  }
}

function modelId(value, field = 'model') {
  if (typeof value !== 'string') {
    throw new OpenRouterProviderError('invalid_model', `${field} must be a model id`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || !MODEL_ID_RE.test(normalized)) {
    throw new OpenRouterProviderError('invalid_model', `${field} must be a valid model id`);
  }
  return normalized;
}

function reasoningEffort(value) {
  if (!REASONING_EFFORT_SET.has(value)) {
    throw new OpenRouterProviderError('invalid_reasoning', 'Invalid reasoning effort');
  }
  return value;
}

function boundedInteger(value, fallback, min, max, field) {
  const chosen = value == null ? fallback : Number(value);
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
    throw new OpenRouterProviderError('invalid_request', `${field} is out of range`);
  }
  return chosen;
}

function boundedNumber(value, fallback, min, max, field) {
  const chosen = value == null ? fallback : Number(value);
  if (!Number.isFinite(chosen) || chosen < min || chosen > max) {
    throw new OpenRouterProviderError('invalid_request', `${field} is out of range`);
  }
  return chosen;
}

function jsonArray(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new OpenRouterProviderError(
      'invalid_request',
      `${field} must be an array with at most ${maxItems} entries`,
    );
  }
  // The caller owns schemas/messages, but cloning here prevents a concurrent
  // tool loop from mutating the request while fetch serializes it.
  try {
    return structuredClone(value);
  } catch {
    throw new OpenRouterProviderError('invalid_request', `${field} must be JSON-serializable`);
  }
}

function buildRequest({
  model,
  reasoning,
  messages,
  tools,
  sessionId,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  temperature = 0.1,
  parallelToolCalls = null,
  toolChoice = 'auto',
  ignoreProviders = null,
}) {
  const copiedTools = jsonArray(tools, 'tools', MAX_TOOLS);
  const availableToolNames = new Set(copiedTools.map((tool) => tool?.function?.name).filter(Boolean));
  let normalizedToolChoice = toolChoice;
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const name = toolChoice.function?.name;
    if (toolChoice.type !== 'function' || typeof name !== 'string' || !availableToolNames.has(name)) {
      throw new OpenRouterProviderError('invalid_request', 'toolChoice must select an available tool');
    }
    normalizedToolChoice = structuredClone(toolChoice);
  } else if (!['auto', 'required', 'none'].includes(toolChoice)) {
    throw new OpenRouterProviderError('invalid_request', 'toolChoice is invalid');
  }
  const request = {
    model: modelId(model),
    messages: jsonArray(messages, 'messages', MAX_MESSAGES),
    tools: copiedTools,
    tool_choice: normalizedToolChoice,
    // 'none' turns the model's thinking off (a helper call on a model other
    // than GLM, services/helper-model.js thinkingFor); reasoningEffort above
    // does not accept it as an effort.
    reasoning: reasoning === 'none' ? { enabled: false } : { effort: reasoningEffort(reasoning) },
    max_tokens: boundedInteger(
      maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      MAX_OUTPUT_TOKENS,
      'maxOutputTokens',
    ),
    // Callers consume tool calls only after the complete response. An
    // atomic response lets OpenRouter fail over before exposing a partial tool
    // envelope and avoids the interrupted SSE streams that previously caused
    // a second 15-second application retry.
    stream: false,
    usage: { include: true },
    // Tool schemas already provide the strict structured-output boundary.
    // Sending response_format at the same time is redundant and excludes or
    // destabilizes providers that reliably implement tools but not the two
    // output modes together.
    // No fallback may reach a host that trains on or keeps the prompt (#5123).
    provider: noTrainingProvider({
      require_parameters: true,
      allow_fallbacks: true,
      // These are short interactive planning calls, so time to first output is
      // more important than sustained token throughput.
      sort: 'latency',
    }),
  };
  // Sent only when a caller asks for it by name (true). With
  // require_parameters above, any parallel_tool_calls OpenRouter sees, false
  // included, routes the call only to providers that list the parameter:
  // for GLM 5.3 Flash one of its thirty-three (Inceptron). Left out, every
  // provider of the model can answer, at its own default, which already
  // allows several tool calls in one reply. The DM (#3772) and the model
  // helpers (#3949) each hit this through a default or an explicit false.
  if (parallelToolCalls === true) request.parallel_tool_calls = true;
  // 31 Oct 2026: a retry sent away from the provider that just failed it.
  // A fresh session alone went back to the same one: sorted by latency,
  // three tries of one DM answer all went to Together and all ran out of
  // output there.
  const ignore = [...new Set((Array.isArray(ignoreProviders) ? ignoreProviders : [])
    .map(providerSlug).filter(Boolean))].slice(0, MAX_IGNORED_PROVIDERS);
  if (ignore.length) request.provider = noTrainingProvider({ ...request.provider, ignore });
  if (temperature != null) {
    request.temperature = boundedNumber(temperature, 0.1, 0, 2, 'temperature');
  }
  if (sessionId != null) {
    const normalized = String(sessionId).trim();
    if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new OpenRouterProviderError('invalid_request', 'Invalid provider session id');
    }
    request.session_id = normalized;
  }
  return request;
}

/**
 * Pure: a provider's routing slug from the name a response gives it, or null
 * for one that does not make a slug ("Together" → "together", "Google AI
 * Studio" → "google-ai-studio"). A slug passes through unchanged.
 */
function providerSlug(name) {
  if (typeof name !== 'string') return null;
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9/._-]+/g, '-').replace(/\.(?=[a-z])/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
  return PROVIDER_SLUG_RE.test(slug) ? slug : null;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integer(value) {
  const number = nonnegative(value);
  return number == null ? null : Math.round(number);
}

function usageFrom(value) {
  const usage = value && typeof value === 'object' ? value : {};
  const promptDetails = usage.prompt_tokens_details || usage.promptTokensDetails || {};
  const completionDetails = usage.completion_tokens_details || usage.completionTokensDetails || {};
  return {
    inputTokens: integer(usage.prompt_tokens ?? usage.promptTokens) ?? 0,
    cachedInputTokens: integer(promptDetails.cached_tokens ?? promptDetails.cachedTokens) ?? 0,
    outputTokens: integer(usage.completion_tokens ?? usage.completionTokens) ?? 0,
    reasoningTokens: integer(
      completionDetails.reasoning_tokens ?? completionDetails.reasoningTokens,
    ) ?? 0,
    costUsd: nonnegative(usage.cost),
  };
}

function contentDelta(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function appendToolCall(map, raw) {
  if (!raw || typeof raw !== 'object') return;
  const index = Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : map.size;
  const existing = map.get(index) || {
    id: '',
    type: 'function',
    function: { name: '', arguments: '' },
  };
  if (typeof raw.id === 'string') existing.id += raw.id;
  if (raw.type === 'function') existing.type = 'function';
  if (raw.function && typeof raw.function === 'object') {
    if (typeof raw.function.name === 'string') existing.function.name += raw.function.name;
    if (typeof raw.function.arguments === 'string') {
      existing.function.arguments += raw.function.arguments;
      if (existing.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
        throw new OpenRouterProviderError('response_too_large', 'Tool arguments exceeded the limit', {
          dispatched: true,
        });
      }
    }
  }
  map.set(index, existing);
}

function timingSnapshot(startedAt, state = {}) {
  return {
    headersMs: state.headersMs == null ? null : state.headersMs,
    firstByteMs: state.firstByteMs == null ? null : state.firstByteMs,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

async function readJsonBody(body, { startedAt, state }) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new OpenRouterProviderError('invalid_response', 'Provider returned no response body', {
      dispatched: true,
      timings: timingSnapshot(startedAt, state),
    });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    if (state.firstByteMs == null) state.firstByteMs = Math.max(0, Date.now() - startedAt);
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new OpenRouterProviderError('response_too_large', 'Provider response exceeded the limit', {
        dispatched: true,
        timings: timingSnapshot(startedAt, state),
      });
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OpenRouterProviderError('invalid_response', 'Provider returned invalid JSON', {
      dispatched: true,
      timings: timingSnapshot(startedAt, state),
    });
  }
}

// Homeroom bot parity, P1 (streamed replies): a caller that passes `onDelta`
// is answered as a stream (`stream: true`), so the words the person will get
// can be shown while the model writes them. Every other caller keeps the
// atomic response above. The raw stream carries a JSON wrapper per token, so
// its byte budget is larger than an atomic body's; what is kept (the content
// and the tool arguments) keeps its own limits.
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_LINE_CHARS = 1024 * 1024;

/**
 * The server-sent events of a streamed completion, folded into the shape an
 * atomic one has ({ id, model, provider, choices: [{ finish_reason, message }],
 * usage, error }). `onDelta({ content, toolCalls })` is called after each
 * read with what has arrived so far (the caller must not change it); a throw
 * there costs the request nothing.
 */
async function readEventStream(body, { startedAt, state, onDelta }) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new OpenRouterProviderError('invalid_response', 'Provider returned no response body', {
      dispatched: true,
      timings: timingSnapshot(startedAt, state),
    });
  }
  const decoder = new TextDecoder('utf-8');
  const out = { id: null, model: null, provider: null, usage: null, error: null, finish: null };
  const toolCalls = new Map();
  let content = '';
  let buffer = '';
  let bytes = 0;
  let done = false;
  const tooLarge = () => new OpenRouterProviderError('response_too_large', 'Provider response exceeded the limit', {
    dispatched: true,
    timings: timingSnapshot(startedAt, state),
  });
  const take = (line) => {
    if (!line.startsWith('data:')) return; // a comment (": OPENROUTER PROCESSING"), an event name, a blank line
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (!chunk || typeof chunk !== 'object') return;
    if (typeof chunk.id === 'string' && !out.id) out.id = chunk.id;
    if (typeof chunk.model === 'string') out.model = chunk.model;
    if (typeof chunk.provider === 'string') out.provider = chunk.provider;
    if (chunk.usage && typeof chunk.usage === 'object') out.usage = chunk.usage;
    if (chunk.error) out.error = chunk.error;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const piece = contentDelta(delta.content);
    if (piece) {
      content += piece;
      if (content.length > MAX_CONTENT_CHARS) throw tooLarge();
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      // A provider that repeats a call's id or name on every delta (rather
      // than sending it once) must not have them joined: "replyreply".
      // One with no index continues the call before it, unless it names a new id.
      if (!call || typeof call !== 'object') continue;
      const last = toolCalls.size ? Math.max(...toolCalls.keys()) : null;
      const at = Number.isInteger(call.index) && call.index >= 0 ? call.index
        : last === null ? 0
          : (typeof call.id === 'string' && call.id && toolCalls.get(last).id && call.id !== toolCalls.get(last).id ? last + 1 : last);
      const before = toolCalls.get(at);
      const fn = call.function && typeof call.function === 'object' ? { ...call.function } : call.function;
      if (before && fn && before.function.name && fn.name === before.function.name) delete fn.name;
      appendToolCall(toolCalls, { ...call, index: at, ...(before && before.id && call.id === before.id ? { id: undefined } : {}), function: fn });
    }
    if (choice.finish_reason) out.finish = choice.finish_reason;
  };
  for await (const chunk of body) {
    if (state.firstByteMs == null) state.firstByteMs = Math.max(0, Date.now() - startedAt);
    const value = typeof chunk === 'string' ? Buffer.from(chunk) : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    bytes += value.byteLength;
    if (bytes > MAX_STREAM_BYTES) throw tooLarge();
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      take(line);
    }
    if (buffer.length > MAX_STREAM_LINE_CHARS) throw tooLarge();
    if (typeof onDelta === 'function') {
      try {
        const said = onDelta({ content, toolCalls: [...toolCalls.values()] });
        if (said && typeof said.catch === 'function') said.catch(() => {});
      } catch {
        // What the caller shows as it streams never fails the request.
      }
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer.trim()) take(buffer.replace(/\r$/, ''));
  return {
    id: out.id,
    model: out.model,
    provider: out.provider,
    ...(out.error ? { error: out.error } : {}),
    choices: [{
      finish_reason: out.finish,
      message: {
        role: 'assistant',
        content,
        tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
      },
    }],
    usage: out.usage,
  };
}

// How much of a refused request's body is read for its provider's name.
const MAX_ERROR_BODY_BYTES = 16 * 1024;
// The longest Retry-After a caller is told about; anything longer is a
// provider that will not be back within one answer.
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/** Pure: a Retry-After header (seconds, or an HTTP date) in milliseconds, or null. */
function retryAfterMs(value, now = Date.now()) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const ms = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), MAX_RETRY_AFTER_MS) : null;
}

/**
 * #3772: what a refused request's answer says about who refused it. OpenRouter
 * names the provider in `error.metadata.provider_name`; a 429 that only ever
 * named "null" could not tell a provider's limit from a key's. Never throws:
 * a body that cannot be read leaves the provider unknown.
 */
async function refusalDetails(response) {
  const details = { provider: null, retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')) };
  const body = response.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return details;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BODY_BYTES) break;
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const name = parsed?.error?.metadata?.provider_name;
    if (typeof name === 'string' && /^[\w .-]{1,80}$/.test(name)) details.provider = name;
  } catch {
    // An unreadable or non-JSON body says nothing more.
  }
  return details;
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
}

async function streamChat({
  apiKey,
  baseUrl,
  origin,
  signal,
  onContent,
  // Homeroom bot parity, P1: what has arrived so far, as it streams
  // (readEventStream). Given, the request is a stream.
  onDelta,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...requestInput
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new OpenRouterProviderError('authentication', 'OpenRouter key is unavailable');
  }
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new OpenRouterProviderError('invalid_request', 'OpenRouter base URL is unavailable');
  }
  if (typeof fetchImpl !== 'function') {
    throw new OpenRouterProviderError('invalid_request', 'Fetch implementation is unavailable');
  }
  const body = buildRequest(requestInput);
  const streamed = typeof onDelta === 'function';
  if (streamed) body.stream = true;
  const startedAt = Date.now();
  const timingState = { headersMs: null, firstByteMs: null };
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), boundedInteger(
    timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000, 'timeoutMs',
  ));
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        ...platformHeaders(origin),
      },
      body: JSON.stringify(withNoTraining(body)),
      signal: combinedSignal,
    });
    timingState.headersMs = Math.max(0, Date.now() - startedAt);
  } catch (err) {
    clearTimeout(timer);
    const timedOut = timeoutController.signal.aborted && !signal?.aborted;
    throw new OpenRouterProviderError(
      timedOut ? 'timeout' : (signal?.aborted ? 'cancelled' : 'network'),
      timedOut ? 'OpenRouter model timed out' : (signal?.aborted ? 'OpenRouter model cancelled' : 'Could not reach the OpenRouter model'),
      { dispatched: true, timings: timingSnapshot(startedAt, timingState) },
    );
  }

  if (!response.ok) {
    // Read under the request's own clock, so a body that never ends cannot
    // hold the caller past its timeout.
    const refused = await refusalDetails(response);
    clearTimeout(timer);
    throw new OpenRouterProviderError(
      providerErrorCode(response.status),
      `OpenRouter model request failed (HTTP ${response.status})`,
      {
        status: response.status,
        dispatched: true,
        provider: refused.provider,
        timings: timingSnapshot(startedAt, timingState),
        retryAfterMs: refused.retryAfterMs,
      },
    );
  }

  let servedModel = null;
  let provider = null;
  let generationId = response.headers?.get?.('x-generation-id') || null;

  try {
    const completion = streamed
      ? await readEventStream(response.body, { startedAt, state: timingState, onDelta })
      : await readJsonBody(response.body, { startedAt, state: timingState });
    generationId ||= typeof completion?.id === 'string' ? completion.id : null;
    servedModel = typeof completion?.model === 'string' ? completion.model : null;
    provider = typeof completion?.provider === 'string' ? completion.provider : null;
    if (completion?.error) {
      throw new OpenRouterProviderError('provider_error', 'Provider reported a generation error', {
        dispatched: true,
        provider,
        generationId,
        timings: timingSnapshot(startedAt, timingState),
      });
    }
    const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
    const message = choice?.message || {};
    const content = contentDelta(message.content);
    if (content.length > MAX_CONTENT_CHARS) {
      throw new OpenRouterProviderError('response_too_large', 'Provider response exceeded the limit', {
        dispatched: true,
        provider,
        generationId,
        timings: timingSnapshot(startedAt, timingState),
      });
    }
    if (content && typeof onContent === 'function') await onContent(content);
    const toolCallParts = new Map();
    for (const call of message.tool_calls || []) appendToolCall(toolCallParts, call);
    const orderedToolCalls = [...toolCallParts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    const finishReason = choice?.finish_reason || null;

    // A missing terminal reason or a length cutoff is incomplete and must
    // never be accepted as a partial action. Distinguish output exhaustion so
    // a caller can grant just one larger retry.
    if (!finishReason || finishReason === 'length') {
      throw new OpenRouterProviderError(
        finishReason === 'length' ? 'output_limit' : 'stream_error',
        finishReason === 'length'
          ? 'OpenRouter model response reached its output limit'
          : 'OpenRouter model response ended before completion',
        {
          dispatched: true,
          provider,
          generationId,
          timings: timingSnapshot(startedAt, timingState),
        },
      );
    }
    return {
      generationId,
      requestedModel: body.model,
      servedModel: servedModel || body.model,
      provider,
      finishReason,
      content,
      toolCalls: orderedToolCalls,
      assistantMessage: {
        role: 'assistant',
        content: content || null,
        ...(orderedToolCalls.length ? { tool_calls: orderedToolCalls } : {}),
      },
      usage: usageFrom(completion.usage),
      timings: timingSnapshot(startedAt, timingState),
    };
  } catch (err) {
    if (err instanceof OpenRouterProviderError) {
      err.provider ||= provider;
      err.generationId ||= generationId;
      err.timings ||= timingSnapshot(startedAt, timingState);
      throw err;
    }
    const timedOut = timeoutController.signal.aborted && !signal?.aborted;
    throw new OpenRouterProviderError(
      timedOut ? 'timeout' : (signal?.aborted ? 'cancelled' : 'stream_error'),
      timedOut ? 'OpenRouter model timed out' : (signal?.aborted ? 'OpenRouter model cancelled' : 'OpenRouter model response failed'),
      {
        dispatched: true,
        provider,
        generationId,
        timings: timingSnapshot(startedAt, timingState),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  OpenRouterProviderError,
  modelId,
  reasoningEffort,
  buildRequest,
  providerSlug,
  usageFrom,
  retryAfterMs,
  streamChat,
};
