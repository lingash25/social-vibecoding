/**
 * Homeroom bot parity, P8: pictures in a design's frame.
 *
 * A picture Homeroom bot made is served to its chat's members only
 * (GET /api/conversations/homeroom-bot/pictures/:id, signed in), and a
 * design's frame is an origin of its own (./frame.ts): a request from inside
 * it carries no sign-in, so the picture would not load there. Before a
 * version is drawn, each picture it names by that address is read here, on
 * the page's own sign-in, and written into the version as a data: address,
 * which the frame's policy allows (`img-src data:`). One read per picture,
 * shared by every frame that shows it; a picture that cannot be read is left
 * as it was.
 */

const PICTURE = /\/api\/conversations\/homeroom-bot\/pictures\/([0-9a-f]{32})/g;
const MAX_PICTURES = 8;
const read = new Map<string, Promise<string | null>>();

function dataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function readPicture(id: string): Promise<string | null> {
  let found = read.get(id);
  if (!found) {
    found = fetch(`/api/conversations/homeroom-bot/pictures/${id}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => (blob && /^image\/(?:png|jpeg|webp)$/.test(blob.type) ? dataUrl(blob) : null))
      .catch(() => null);
    read.set(id, found);
    void found.then((url) => { if (!url) read.delete(id); });
  }
  return found;
}

/** Pure: the picture ids a version names, in order, at most MAX_PICTURES. */
export function pictureIds(html: string): string[] {
  const out: string[] = [];
  for (const m of String(html || '').matchAll(PICTURE)) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= MAX_PICTURES) break;
  }
  return out;
}

/** A version's HTML with its pictures written in as data: addresses. Never rejects. */
export async function inlinePictures(html: string): Promise<string> {
  const ids = pictureIds(html);
  if (!ids.length || typeof fetch !== 'function' || typeof FileReader === 'undefined') return html;
  const urls = await Promise.all(ids.map((id) => readPicture(id)));
  let out = String(html);
  ids.forEach((id, i) => {
    const url = urls[i];
    // The address as written, with this site's origin before it or not.
    if (url) out = out.replace(new RegExp(`(?:https?://[^"'\\s()<>]+)?/api/conversations/homeroom-bot/pictures/${id}`, 'g'), () => url);
  });
  return out;
}
