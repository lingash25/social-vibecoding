'use strict';

// Homeroom bot parity, P2: the "table" card (see ./index.js), made by
// show_table (../homeroom-bot-thread-tools/cards.js):
//
//   { type: 'table', v: 1, title?, columns: [..], rows: [{ cells: [..], tag?, appSlug?, appName?, number? }],
//     more?, actions?: [{ label, say }] }
//
// Nothing on it is decided here: a row opens its request, and a button says
// its words as the person (the client's own). Its history line is what the
// model reads back.

const MAX_ROWS_READ = 12;
const list = (value) => (Array.isArray(value) ? value : []);

async function decide() {
  return { ok: false, status: 400, error: 'That is not something this card does' };
}

/** Pure: how the card reads in the model's history (index.js historyLine). */
function historyLine(card) {
  const columns = list(card?.columns).filter((c) => typeof c === 'string');
  const rows = list(card?.rows).filter((r) => r && Array.isArray(r.cells)).slice(0, MAX_ROWS_READ);
  if (!columns.length || !rows.length) return null;
  const read = rows.map((r) => {
    const about = r.appSlug && r.number ? ` [${r.appName || r.appSlug} request #${r.number}]` : '';
    return `${r.cells.join(' | ')}${r.tag ? ` (${r.tag})` : ''}${about}`;
  }).join('; ');
  const more = Number(card.more) > 0 ? ` And ${Number(card.more)} more.` : '';
  const actions = list(card.actions).filter((a) => a && a.label).map((a) => `"${a.label}"`).join(', ');
  return `[Homeroom: under this reply you showed a table${card.title ? ` "${card.title}"` : ''}: ${columns.join(' | ')}; ${read}.${more}`
    + `${actions ? ` Its buttons: ${actions}.` : ''}]`;
}

module.exports = { decide, historyLine };
