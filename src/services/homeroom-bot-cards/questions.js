'use strict';

// Homeroom bot parity, P2: taps on the "questions" card (see ./index.js),
// made by ask_questions (../homeroom-bot-thread-tools/cards.js):
//
//   { type: 'questions', v: 1, title?, questions: [{ question, answers: [..], guess? }],
//     answered: null | ['answer to 1', ...], skipped?: true }
//
// Send answers is decided here ('answer', the answers in the questions'
// order), and You decide too ('skip'), so the card shows them read-only on
// every device; the client then says them as the person, numbered.

const MAX_ANSWER_CHARS = 200;
const list = (value) => (Array.isArray(value) ? value : []);

/** Pure: the answers a tap sends, one per question, cleaned; null when they do not fit the card. */
function answersFor(card, value) {
  const questions = list(card?.questions);
  if (!questions.length || !Array.isArray(value) || value.length !== questions.length) return null;
  const answers = value.map((a) => (typeof a === 'string' ? a.replace(/\s+/g, ' ').trim() : ''))
    .map((a) => (a.length > MAX_ANSWER_CHARS ? `${a.slice(0, MAX_ANSWER_CHARS - 1)}…` : a));
  return answers.every(Boolean) ? answers : null;
}

async function decide(_pool, _config, { card, action, value }) {
  if (action !== 'answer' && action !== 'skip') return { ok: false, status: 400, error: 'That is not something this card does' };
  // Answered already, here or on another device: the card shows how.
  if (Array.isArray(card.answered) || card.skipped) {
    return { ok: true, already: true, ...(Array.isArray(card.answered) ? { answered: card.answered } : { skipped: true }) };
  }
  if (action === 'skip') return { ok: true, skipped: true, patch: { skipped: true, answeredAt: new Date().toISOString() } };
  const answers = answersFor(card, value);
  if (!answers) return { ok: false, status: 400, error: 'Answer each question first' };
  return { ok: true, answered: answers, patch: { answered: answers, answeredAt: new Date().toISOString() } };
}

/** Pure: how the card reads in the model's history (index.js historyLine). */
function historyLine(card) {
  const questions = list(card?.questions).filter((q) => q && q.question);
  if (!questions.length) return null;
  const asked = questions.map((q, i) => {
    const answers = list(q.answers);
    const guess = Number.isInteger(q.guess) && answers[q.guess] ? `, your guess: ${answers[q.guess]}` : '';
    return `${i + 1}. ${q.question} (suggested: ${answers.join(' / ')}${guess})`;
  }).join(' ');
  const how = Array.isArray(card.answered)
    ? `They answered: ${card.answered.map((a, i) => `${i + 1}. ${a}`).join(' ')}.`
    : card.skipped ? 'They left it to you to decide.' : 'They have not answered yet.';
  return `[Homeroom: under this reply you asked these questions${card.title ? ` about "${card.title}"` : ''}: ${asked} ${how}]`;
}

module.exports = { decide, historyLine, answersFor, MAX_ANSWER_CHARS };
