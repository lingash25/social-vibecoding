'use strict';

// Homeroom bot parity, P8: taps on the "gallery" card (see ./index.js), the
// pictures make_pictures made (services/bot-pictures.js), decided as the
// person:
//
//   feature  value: a picture's id. Opens the vote on it as the project's
//            card picture (with its dark variant when the gallery has one),
//            for a person who may propose one; patch { featured }.
//   use      value: a picture's id. Keeps it as one of their screenshots, the
//            way a request carries pictures, and answers its link, which the
//            client says as theirs so the bot offers a request carrying it;
//            patch { used }.
//   design   value: a picture's id. Adds it to the design thread's pictures
//            for its next version (a gallery in a design thread only);
//            patch { designed }.
//
// "More like A" is the person's own words (sayAsMe) and never reaches here.

function pictures(deps = {}) { return deps.botPictures || require('../bot-pictures'); }

/** Pure: the same letter's other variant in the card, or null. */
function sibling(card, image, variant) {
  return (card.images || []).find((im) => im && im.id !== image.id && im.letter === image.letter && im.variant === variant) || null;
}

async function decide(pool, config, { user, card, action, value, deps = {} }) {
  const p = pictures(deps);
  const image = p.cardImage(card, value);
  if (!image) return { ok: false, status: 404, error: 'No such picture' };
  if (action === 'feature') {
    if (!card.canFeature || !card.project?.slug) {
      return { ok: false, status: 403, error: 'Only the project\'s creator and its admins can propose its card picture.' };
    }
    if (card.featured?.href) return { ok: true, already: true, proposal: { href: card.featured.href } };
    // The light picture goes in as the card's, the dark one as its dark.
    const light = image.variant === 'dark' ? (sibling(card, image, 'light') || image) : image;
    const dark = image.variant === 'dark' && light !== image ? image : sibling(card, light, 'dark');
    const out = await p.featurePicture(pool, config, { user, card, image: light, dark, deps });
    if (!out.ok) return out;
    return {
      ok: true, proposal: out.proposal,
      patch: { featured: { id: image.id, letter: image.letter, href: out.proposal.href } },
    };
  }
  if (action === 'use') {
    const out = await p.pictureToScreenshot(pool, config, { user, image, deps });
    if (!out.ok) return out;
    const used = Array.isArray(card.used) ? card.used.filter((u) => u && u.id !== image.id) : [];
    return { ok: true, url: out.url, patch: { used: [...used, { id: image.id, url: out.url }].slice(-8) } };
  }
  if (action === 'design') {
    if (!card.designRootId) return { ok: false, status: 400, error: 'These pictures are not in a design thread.' };
    const out = await p.addToDesign(pool, { user, rootId: card.designRootId, image, deps });
    if (!out.ok) return out;
    const designed = Array.isArray(card.designed) ? card.designed.filter((id) => id !== image.id) : [];
    return { ok: true, patch: { designed: [...designed, image.id].slice(-8) } };
  }
  return { ok: false, status: 400, error: 'Unknown action' };
}

module.exports = { decide, sibling };
