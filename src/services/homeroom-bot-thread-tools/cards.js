'use strict';

// Homeroom bot parity, P2: cards the bot puts under a reply of its own
// making (see ./index.js for this module's shape):
//
//   offer_options  2 to 4 ways to do something, each with Show and Pick
//                  (a pick is said on every device: ../homeroom-bot-cards/options.js)
//   ask_questions  1 to 4 questions answered together, each with suggested
//                  answers and an Other field (../homeroom-bot-cards/questions.js)
//   show_table     a short table, its rows about requests linked to them, a
//                  tag on a row, and buttons that say something for them
//                  (../homeroom-bot-cards/table.js)
//
// Everything the model passes is checked and clipped here (cardFrom* are
// pure); a call that cannot make a card is answered with what to fix, and
// nothing is shown. A card's words are the model's and are drawn as text,
// never HTML (frontend features/messages/bot-cards/).

const { withoutEmDashes } = require('../em-dashes');

const KEYS = Object.freeze(['A', 'B', 'C', 'D']);
const TAGS = Object.freeze(['ready', 'question', 'done', 'stopped']);
const LIMITS = Object.freeze({
  title: 90,
  optionTitle: 90,
  optionDetail: 280,
  question: 200,
  answer: 80,
  column: 40,
  cell: 140,
  actionLabel: 40,
  actionSay: 240,
  minOptions: 2,
  maxOptions: 4,
  maxQuestions: 4,
  minAnswers: 2,
  maxAnswers: 4,
  minColumns: 2,
  maxColumns: 4,
  maxRows: 12,
  maxActions: 3,
  maxMore: 100000,
});

/** Pure: words the model passed, as a card shows them: one line, no em dash, at most `max` characters, or ''. */
function words(value, max) {
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) return '';
  const text = withoutEmDashes(String(value)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const list = (value) => (Array.isArray(value) ? value : []);

/** Pure: an options card from offer_options' arguments: { card, notes } or { error }. */
function cardFromOptions(args = {}) {
  const raw = list(args.options);
  const options = [];
  for (const entry of raw) {
    const title = words(typeof entry === 'string' ? entry : entry?.title, LIMITS.optionTitle);
    if (!title) continue;
    const detail = typeof entry === 'object' && entry ? words(entry.detail, LIMITS.optionDetail) : '';
    options.push({ key: KEYS[options.length], title, ...(detail ? { detail } : {}) });
    if (options.length === LIMITS.maxOptions) break;
  }
  if (options.length < LIMITS.minOptions) {
    return { error: `offer_options needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options, each with a short title. Nothing was shown.` };
  }
  const notes = [];
  if (raw.length > options.length) notes.push(`Only the first ${options.length} options are shown.`);
  const title = words(args.title, LIMITS.title);
  return { card: { type: 'options', v: 1, ...(title ? { title } : {}), options, picked: null }, notes };
}

/** Pure: a question set from ask_questions' arguments: { card, notes } or { error }. */
function cardFromQuestions(args = {}) {
  const raw = list(args.questions);
  const questions = [];
  const notes = [];
  for (const entry of raw) {
    const question = words(entry?.question, LIMITS.question);
    if (!question) continue;
    const answers = [];
    for (const answer of list(entry.answers)) {
      const said = words(answer, LIMITS.answer);
      if (said && !answers.includes(said)) answers.push(said);
      if (answers.length === LIMITS.maxAnswers) break;
    }
    if (answers.length < LIMITS.minAnswers) {
      return { error: `Each question needs ${LIMITS.minAnswers} to ${LIMITS.maxAnswers} short suggested answers ("${question}" has ${answers.length}). Nothing was shown.` };
    }
    const guess = Number(entry.guess);
    questions.push({ question, answers, ...(Number.isInteger(guess) && guess >= 0 && guess < answers.length ? { guess } : {}) });
    if (questions.length === LIMITS.maxQuestions) break;
  }
  if (!questions.length) return { error: `ask_questions needs 1 to ${LIMITS.maxQuestions} questions, each with its suggested answers. Nothing was shown.` };
  if (raw.length > questions.length) notes.push(`Only the first ${questions.length} questions are shown.`);
  const title = words(args.title, LIMITS.title);
  return { card: { type: 'questions', v: 1, ...(title ? { title } : {}), questions, answered: null }, notes };
}

/** Pure: a table from show_table's arguments, rows not yet linked (linkRows): { card, notes } or { error }. */
function cardFromTable(args = {}) {
  const notes = [];
  const rawColumns = list(args.columns);
  const columns = rawColumns.map((c) => words(c, LIMITS.column)).slice(0, LIMITS.maxColumns);
  if (columns.length < LIMITS.minColumns || columns.some((c) => !c)) {
    return { error: `show_table needs ${LIMITS.minColumns} to ${LIMITS.maxColumns} columns, each with a short heading. Nothing was shown.` };
  }
  if (rawColumns.length > columns.length) notes.push(`Only the first ${columns.length} columns are shown.`);
  const rawRows = list(args.rows);
  const rows = [];
  for (const entry of rawRows) {
    const cellsIn = Array.isArray(entry) ? entry : list(entry?.cells);
    const cells = columns.map((_, i) => words(cellsIn[i], LIMITS.cell));
    if (!cells.some(Boolean)) continue;
    const tag = typeof entry?.tag === 'string' && TAGS.includes(entry.tag.trim().toLowerCase()) ? entry.tag.trim().toLowerCase() : null;
    const number = Number(entry?.number);
    const project = words(entry?.project, 80);
    rows.push({
      cells,
      ...(tag ? { tag } : {}),
      ...(project && Number.isSafeInteger(number) && number > 0 && number < 1e8 ? { project, number } : {}),
    });
    if (rows.length === LIMITS.maxRows) break;
  }
  if (!rows.length) return { error: 'show_table needs at least one row, each with its cells in the columns\' order. Nothing was shown.' };
  const moreGiven = Number(args.more);
  let more = Number.isInteger(moreGiven) && moreGiven > 0 ? Math.min(moreGiven, LIMITS.maxMore) : 0;
  const left = rawRows.length - rows.length;
  if (left > 0 && rawRows.length > LIMITS.maxRows) {
    more = Math.max(more, left);
    notes.push(`Only ${rows.length} rows are shown; the card says ${more} more.`);
  }
  const actions = [];
  for (const entry of list(args.actions)) {
    const label = words(entry?.label, LIMITS.actionLabel);
    const say = words(entry?.say || entry?.label, LIMITS.actionSay);
    if (label && say && !actions.some((a) => a.label === label)) actions.push({ label, say });
    if (actions.length === LIMITS.maxActions) break;
  }
  const title = words(args.title, LIMITS.title);
  return {
    card: { type: 'table', v: 1, ...(title ? { title } : {}), columns, rows, ...(more ? { more } : {}), ...(actions.length ? { actions } : {}) },
    notes,
  };
}

/**
 * A table's rows about requests, linked: each row naming a project and a
 * number gets the project's slug and name when this person can see it, and
 * loses the link when not (its words stay). Never throws.
 */
async function linkRows(pool, ctx, card) {
  const mayor = (ctx?.deps && ctx.deps.mayor) || require('../homeroom-bot-mayor');
  const seen = new Map();
  const rows = [];
  for (const row of card.rows) {
    if (!row.project) { rows.push(row); continue; }
    const { project, number, ...rest } = row;
    if (!seen.has(project)) {
      let app = null;
      try {
        const found = await mayor.findApp(pool, project);
        app = found && await mayor.canView(pool, found, ctx.user) ? found : null;
      } catch {
        app = null;
      }
      seen.set(project, app);
    }
    const app = seen.get(project);
    if (app && app.id && ctx.appIds instanceof Set) ctx.appIds.add(Number(app.id));
    rows.push(app ? { ...rest, appSlug: String(app.slug), appName: String(app.name || app.slug), number } : rest);
  }
  return { ...card, rows };
}

const TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'offer_options',
      description: 'Put 2 to 4 options under your reply as a card to pick from, when they ask for ways, options or alternatives. '
        + 'Each option has a short title and one line of detail; the card letters them A, B, C, D. Under each are Show (you are '
        + 'then asked to show or explain that option) and Pick (you are told their pick). One card per reply.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the options are for, in a few words ("Ways to add reminders").' },
          options: {
            type: 'array',
            minItems: LIMITS.minOptions,
            maxItems: LIMITS.maxOptions,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: `The option in a few words, at most ${LIMITS.optionTitle} characters.` },
                detail: { type: 'string', description: `One line on what it means for them, at most ${LIMITS.optionDetail} characters.` },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['options'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_questions',
      description: 'Ask 1 to 4 questions at once as a card under your reply, when you need their answers before you can go on. '
        + 'Each question has 2 to 4 short suggested answers and, when you have one, your guess (its index). They tap an answer '
        + 'or write their own, then send them all together, or tap You decide. One card per reply.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the questions are about, in a few words.' },
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: LIMITS.maxQuestions,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: `One short question, at most ${LIMITS.question} characters.` },
                answers: {
                  type: 'array',
                  minItems: LIMITS.minAnswers,
                  maxItems: LIMITS.maxAnswers,
                  items: { type: 'string' },
                  description: `Suggested answers, each at most ${LIMITS.answer} characters.`,
                },
                guess: { type: 'integer', description: 'The index (from 0) of the answer you would pick, when you have a guess.' },
              },
              required: ['question', 'answers'],
              additionalProperties: false,
            },
          },
        },
        required: ['questions'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_table',
      description: 'Show a short table under your reply, when things side by side read better than sentences: their requests and '
        + 'where each stands, options compared, a plan\'s steps. 2 to 4 columns, up to 12 rows. A row about a request names its '
        + 'project and number, so it links to the request. A row may carry one tag: ready, question, done or stopped. Up to 3 '
        + 'buttons say something for them when tapped. One card per reply.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the table shows, in a few words.' },
          columns: {
            type: 'array', minItems: LIMITS.minColumns, maxItems: LIMITS.maxColumns, items: { type: 'string' },
            description: `The column headings, each at most ${LIMITS.column} characters.`,
          },
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: LIMITS.maxRows,
            items: {
              type: 'object',
              properties: {
                cells: { type: 'array', items: { type: 'string' }, description: `One short cell per column, in order, each at most ${LIMITS.cell} characters.` },
                tag: { type: 'string', enum: [...TAGS], description: 'Where it stands, when it is one of these.' },
                project: { type: 'string', description: 'For a row about a request: its project\'s name or short name.' },
                number: { type: 'integer', description: 'For a row about a request: its number.' },
              },
              required: ['cells'],
              additionalProperties: false,
            },
          },
          more: { type: 'integer', description: 'How many more rows there are that the table leaves out.' },
          actions: {
            type: 'array',
            maxItems: LIMITS.maxActions,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: `The button, at most ${LIMITS.actionLabel} characters ("Build the ready ones").` },
                say: { type: 'string', description: 'What it says for them when tapped, in their words, as if they typed it.' },
              },
              required: ['label', 'say'],
              additionalProperties: false,
            },
          },
        },
        required: ['columns', 'rows'],
        additionalProperties: false,
      },
    },
  },
]);

const NAMES = new Set(TOOLS.map((tool) => tool.function.name));

const SHOWN = Object.freeze({
  options: 'Under your reply they see the options as a card, lettered, each with Show and Pick. Keep your reply to a short lead-in: do not list the options again.',
  questions: 'Under your reply they see the questions as a card with your suggested answers, an Other field and Send answers. Keep your reply to a short lead-in: do not repeat the questions.',
  table: 'Under your reply they see the table as a card. Keep your reply short: say what it shows and what stands out, not every row.',
});

async function run(pool, ctx, name, args) {
  if (!NAMES.has(name)) return undefined;
  const made = name === 'offer_options' ? cardFromOptions(args)
    : name === 'ask_questions' ? cardFromQuestions(args)
      : cardFromTable(args);
  if (made.error) return { ok: false, error: made.error };
  const card = made.card.type === 'table' ? await linkRows(pool, ctx, made.card) : made.card;
  const replaced = !!ctx.card;
  ctx.card = card;
  return {
    ok: true,
    shown: SHOWN[card.type],
    ...(made.notes.length || replaced ? { note: [...made.notes, ...(replaced ? ['It replaces the card you put under this reply before: one card per reply.'] : [])].join(' ') } : {}),
  };
}

function promptLines() {
  return [
    '- Offer a few ways to do something as a card to pick from when they ask for options, ways or alternatives, or how',
    '  they could do something (offer_options: 2 to 4, each a short title and one line of detail). Your reply leads in',
    '  briefly; the card lists them. They tap Show to see one (show or explain it, a drawing when it is a screen) or Pick.',
    '- Ask several questions at once as a card when you need their answers before you can go on (ask_questions: up to 4,',
    '  each with 2 to 4 suggested answers and your guess). They answer them together, and the answers come back numbered.',
    '- Show things side by side as a table card when that reads better than sentences, such as their requests and where',
    '  each stands (show_table: 2 to 4 columns, up to 12 rows; a row about a request names its project and number so it',
    '  links to it; tag a row ready, question, done or stopped; up to 3 buttons that say something for them).',
    '- One card per reply. A card is not an answer by itself: the reply still says, in a sentence or two, what it is.',
  ];
}

module.exports = {
  tools: () => TOOLS,
  run,
  promptLines,
  // For tests and the card handlers.
  TOOLS,
  KEYS,
  TAGS,
  LIMITS,
  words,
  cardFromOptions,
  cardFromQuestions,
  cardFromTable,
  linkRows,
};
