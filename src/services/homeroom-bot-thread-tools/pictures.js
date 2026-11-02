'use strict';

// Homeroom bot parity, P8: pictures from an outside image model, in the
// person's chat with the bot (see ./index.js for this module's shape).
//
// `make_pictures` asks services/bot-pictures.js for up to four options (A to
// D), each in a light and a dark variant when asked for, paid from the
// person's own week of building time and a weekly number of pictures, and
// puts them under the reply as a gallery card (homeroom-bot-cards/gallery.js,
// frontend features/messages/bot-cards/gallery.tsx). The card carries ids
// and addresses only; the pictures are in the media store.

const log = require('../logger');

function pictures(deps = {}) { return deps.botPictures || require('../bot-pictures'); }
function mayor(deps = {}) { return deps.mayor || require('../homeroom-bot-mayor'); }

const TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'make_pictures',
    description: 'Make pictures with an outside picture model: a project\'s card picture, a picture for its app (a hero image, '
      + 'an illustration, an empty state), one for a design, or anything else they ask for. Up to 4 different options (A to D), '
      + 'each in light and dark when it must suit both themes. They are shown as a gallery under your reply. Each picture counts '
      + 'toward their own week of building time and a weekly number of pictures. You cannot see the pictures: never say what one shows.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw, in plain words: the subject, the style, the colours and the mood, from what they asked. No words in the picture unless they asked for some.' },
        count: { type: 'integer', description: 'How many different options, 1 to 4. 1 unless they asked for choices.' },
        variants: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] }, description: 'Both, for a picture that must suit a light and a dark theme (a card picture usually does). Leave it out for one picture.' },
        aspect: { type: 'string', enum: ['square', 'wide', 'tall'], description: 'Square unless it is for a wide banner (wide) or a phone screen (tall).' },
        for: { type: 'string', enum: ['featured', 'app', 'design', 'other'], description: 'featured: the project\'s card picture in Discover; app: a picture inside the app; design: for a screen design; other: anything else.' },
        project: { type: 'string', description: 'The project it is for, by name, when it is for one. Needed for a card picture.' },
        like: { type: 'string', description: 'The letter (A to D) of a picture in the last gallery here, to make more like it.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
});

function offered(ctx) {
  return !!ctx?.user?.id && !ctx.user.isSynthetic && ctx.settings?.mode !== 'off'
    && Number(ctx.settings?.pictureWeeklyCap ?? 1) !== 0;
}

function tools(ctx) {
  return offered(ctx) ? [TOOL] : [];
}

function promptLines(ctx) {
  if (!offered(ctx)) return [];
  return [
    '- Make pictures with an outside picture model (make_pictures): up to 4 options (A to D), in light and dark when they',
    '  need both, for a project\'s card picture, for its app, for a design, or anything else they ask for. They are shown',
    '  as a gallery under your reply, which they tap to propose one as the card picture (only where they may), to use one in',
    '  the app, or to get more like one. Each picture counts toward their own week of building time and a weekly number of',
    '  pictures; say so when they ask what it costs. You cannot see the pictures, so never say what one shows. Content',
    '  rules: nothing sexual or suggestive, no violence or weapons, no gambling, nothing aimed at children, no real',
    '  person\'s likeness and no brands or logos they did not give you. Decline those plainly instead of calling it.',
    '  When they ask to use a picture in the app, offer a request (offer_request) whose details carry the picture\'s link',
    '  exactly as they gave it, on a line of its own, so the build can download it. When they ask for more like one, call',
    '  make_pictures again with like set to its letter and a prompt from their words and the last one.',
  ];
}

/** The picture `letter` of the newest gallery here, as bytes to draw more like it, or { error }. */
async function likePicture(pool, ctx, letter, deps) {
  const p = pictures(deps);
  const gallery = await p.latestGallery(pool, { conversationId: ctx.conversationId, threadRootId: ctx.deps?.threadRootId || null });
  const images = gallery?.images || [];
  const im = images.find((i) => i?.letter === letter && i?.variant !== 'dark') || images.find((i) => i?.letter === letter);
  if (!im) return { error: `There is no picture ${letter} in the last gallery here. Nothing was made.` };
  const row = await p.imageForMember(pool, { userId: ctx.user.id, id: im.id });
  if (!row) return { error: `Picture ${letter} cannot be read just now. Nothing was made.` };
  return { picture: { contentType: row.content_type, data: await p.imageBytes(ctx.config, row, deps) } };
}

async function makePictures(pool, ctx, args) {
  const deps = ctx.deps?.pictures || {};
  const p = pictures(deps);
  const ask = p.normalizeAsk(args);
  if (ask.error) return { ok: false, error: `${ask.error} Nothing was made.` };
  // A refusal on the content rules costs nothing, and comes first.
  const found = p.guard(ask.prompt);
  if (found) return { ok: false, error: p.refusalText(found) };
  let app = null;
  if (typeof args.project === 'string' && args.project.trim()) {
    const m = mayor(ctx.deps);
    app = await m.findApp(pool, args.project);
    if (!app || !(await m.canView(pool, app, ctx.user))) {
      return { ok: false, error: 'There is no project by that name that they can see. Check the name with my_projects. Nothing was made.' };
    }
  }
  if (ask.purpose === 'featured' && !app) {
    return { ok: false, error: 'Say which project the card picture is for (project). Nothing was made.' };
  }
  let like = null;
  if (ask.like) {
    const found2 = await likePicture(pool, ctx, ask.like, deps);
    if (found2.error) return { ok: false, error: found2.error };
    like = found2.picture;
  }
  const made = await p.generate(pool, ctx.config, {
    payerId: ctx.user.id, ask, conversationId: ctx.conversationId, app, settings: ctx.settings, like, deps,
  });
  if (!made.ok) return { ok: false, error: made.error };
  let canFeature = false;
  if (app) {
    canFeature = await (deps.appAdmins || require('../app-admins')).canManageApp(pool, app, ctx.user).catch(() => false);
  }
  ctx.card = p.galleryCard({
    prompt: ask.prompt, images: made.images, variants: ask.variants, purpose: ask.purpose, canFeature,
    project: app ? { slug: app.slug, name: app.name || app.slug } : null,
  });
  const n = made.images.length;
  // "What I looked at" (P1): what this turn did, in plain words.
  ctx.looked = Array.isArray(ctx.looked) ? ctx.looked : [];
  ctx.looked.push({ what: `Made ${n} picture${n === 1 ? '' : 's'} with the picture model` });
  ctx.lookedMs = (Number(ctx.lookedMs) || 0) + (Number(made.ms) || 0);
  ctx.pictures = { made: n };
  return {
    ok: true,
    made: n,
    labels: ctx.card.images.map((im) => im.label),
    shown: 'As a gallery under your reply. Say how many you made and what they are for, in a sentence; you cannot see them.',
    picturesLeftThisWeek: made.left,
    ...(made.failed ? { notMade: `${made.failed} of them could not be made this time.` } : {}),
    ...(canFeature ? { canFeature: 'They may propose one as the project\'s card picture from the gallery.' } : {}),
  };
}

async function run(pool, ctx, name, args) {
  if (name !== 'make_pictures') return undefined;
  try {
    return await makePictures(pool, ctx, args || {});
  } catch (err) {
    log.warn('homeroom-bot-pictures', 'make_pictures failed', { userId: ctx?.user?.id, err: err.message });
    return { ok: false, error: 'The pictures could not be made just now. Try again in a minute.' };
  }
}

module.exports = { TOOL, tools, run, promptLines, makePictures };
