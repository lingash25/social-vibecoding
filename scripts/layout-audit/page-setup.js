// Runs in the page before any of the shell's own code (the driver hands it
// to Page.addScriptToEvaluateOnNewDocument). Two stand-ins, both for things a
// headless browser does not have:
//
// * A socket that opens and stays quiet. The audit's network answers HTTP
//   only; a real socket would fail, and the shell would draw its
//   "Reconnecting" banner over every screen.
//
// * A keyboard. iOS shows the on-screen keys by shrinking the VISUAL
//   viewport over a layout viewport that stays the same size, and the native
//   kit (public/usernode-native/v1/native.js) and the shell
//   (frontend/src/lib/keyboard-open.ts) read that to mark the keyboard as up.
//   `window.__layoutAudit.keyboard(px)` does the same to this page's
//   visualViewport, so the code that reacts to a keyboard is the code that
//   runs, not a copy of what it would have set.
(() => {
  class QuietSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        const event = new Event('open');
        if (typeof this.onopen === 'function') this.onopen(event);
        this.dispatchEvent(event);
      }, 0);
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const event = new CloseEvent('close', { code: 1000, wasClean: true });
      if (typeof this.onclose === 'function') this.onclose(event);
      this.dispatchEvent(event);
    }
  }
  QuietSocket.CONNECTING = 0;
  QuietSocket.OPEN = 1;
  QuietSocket.CLOSING = 2;
  QuietSocket.CLOSED = 3;
  window.WebSocket = QuietSocket;

  const real = window.visualViewport;
  let covered = 0;
  const events = new EventTarget();
  if (real) {
    const relay = (type) => real.addEventListener(type, () => events.dispatchEvent(new Event(type)));
    relay('resize');
    relay('scroll');
    const fake = {
      get width() { return real.width; },
      get height() { return Math.max(0, real.height - covered); },
      get offsetTop() { return real.offsetTop; },
      get offsetLeft() { return real.offsetLeft; },
      get pageTop() { return real.pageTop; },
      get pageLeft() { return real.pageLeft; },
      get scale() { return real.scale; },
      onresize: null,
      onscroll: null,
      addEventListener: (type, fn, opts) => events.addEventListener(type, fn, opts),
      removeEventListener: (type, fn, opts) => events.removeEventListener(type, fn, opts),
      dispatchEvent: (event) => events.dispatchEvent(event),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  }

  window.__layoutAudit = {
    /** Cover `px` of the bottom of the screen with a keyboard, or 0 to drop it. */
    keyboard(px) {
      covered = Math.max(0, Number(px) || 0);
      const event = new Event('resize');
      events.dispatchEvent(event);
      if (window.visualViewport && typeof window.visualViewport.onresize === 'function') window.visualViewport.onresize(event);
      window.dispatchEvent(new Event('resize'));
    },
    get keyboardHeight() { return covered; },
  };
})();
