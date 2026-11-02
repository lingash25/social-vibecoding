'use strict';

// Homeroom bot parity (P1-P9): the tools a conversation with the bot gains
// beyond homeroom-bot-mayor.js's own TOOLS, one module per part. The chat
// model stays the cheap one (DeepSeek V4.1 Flash by default): what these add
// is hands, not a bigger model.
//
// Each module exports:
//   tools(ctx)                   -> OpenAI-style function tools offered this turn ([] when it does not apply)
//   run(pool, ctx, name, args)   -> the tool's result, or undefined when `name` is not one of its tools
//   promptLines(ctx)             -> lines added to the system prompt this turn ([] when none)
//
// `ctx` is homeroom-bot-mayor.js answer()'s turn context: user (with isAdmin),
// settings, config, deps (threadRootId, threadRequest, threadDraft, …),
// conversationId, messageId, userText. A tool that wants a card under the
// reply sets ctx.card = { type, v: 1, ... } (homeroom-bot-cards/README in
// index.js there); answer() sends it as the reply's metadata `card`.
//
// Modules never throw out of run(): an error is a result the model reads.

const log = require('../logger');

const MODULES = Object.freeze([
  ['cards', () => require('./cards')], // P2: options, question set, table
  ['look-into', () => require('./look-into')], // P3: a read-only worker turn
  ['batch', () => require('./batch')], // P4: work through many requests
  ['steer', () => require('./steer')], // P5: a note into a running build, stop and redo
  ['admin', () => require('./admin')], // P7: admin tools behind confirm cards
  ['pictures', () => require('./pictures')], // P8: pictures from an outside image model
  ['investigate', () => require('./investigate')], // P9: investigations that run for days
]);

function modules(deps = {}) {
  if (Array.isArray(deps.threadToolModules)) return deps.threadToolModules;
  return MODULES.map(([name, load]) => {
    try {
      return { name, ...load() };
    } catch (err) {
      log.warn('homeroom-bot-thread-tools', 'A thread tool module could not load', { module: name, err: err.message });
      return null;
    }
  }).filter(Boolean);
}

/** The extra tools this turn offers, in module order. Never throws. */
function toolsFor(ctx) {
  const out = [];
  const seen = new Set();
  for (const mod of modules(ctx?.deps)) {
    let list = [];
    try {
      list = typeof mod.tools === 'function' ? mod.tools(ctx) || [] : [];
    } catch (err) {
      log.warn('homeroom-bot-thread-tools', 'A thread tool module could not list its tools', { module: mod.name, err: err.message });
    }
    for (const tool of list) {
      const name = tool?.function?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(tool);
    }
  }
  return out;
}

/** Lines for the system prompt, from every module that has something to say this turn. */
function promptLines(ctx) {
  const out = [];
  for (const mod of modules(ctx?.deps)) {
    try {
      const lines = typeof mod.promptLines === 'function' ? mod.promptLines(ctx) || [] : [];
      out.push(...lines.filter((line) => typeof line === 'string'));
    } catch (err) {
      log.warn('homeroom-bot-thread-tools', 'A thread tool module could not say its prompt lines', { module: mod.name, err: err.message });
    }
  }
  return out;
}

/** Run `name` if a module owns it; undefined when none does. Never throws. */
async function run(pool, ctx, name, args) {
  for (const mod of modules(ctx?.deps)) {
    let owns = false;
    try {
      owns = (typeof mod.tools === 'function' ? mod.tools(ctx) || [] : []).some((t) => t?.function?.name === name);
    } catch {
      owns = false;
    }
    if (!owns) continue;
    try {
      return await mod.run(pool, ctx, name, args || {});
    } catch (err) {
      log.warn('homeroom-bot-thread-tools', 'A thread tool failed', { module: mod.name, tool: String(name).slice(0, 40), err: err.message });
      return { ok: false, error: 'That did not work just now. Nothing was changed.' };
    }
  }
  return undefined;
}

module.exports = { toolsFor, promptLines, run, MODULES };
