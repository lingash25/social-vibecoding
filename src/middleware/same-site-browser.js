'use strict';

// Refuse a BROWSER request that did not come from the Homeroom page itself.
//
// The session cookie is SameSite=Lax, and child apps and staging previews
// are served on subdomains of the platform's own domain — the same SITE. So a
// page on one of them can send a credentialed, bodyless POST to the platform
// (no JSON body, so no CORS preflight) and the cookie rides along. For a
// cookie-authenticated write that needs nothing but the URL, that is enough
// to act for a signed-in visitor.
//
// The rule is the Sec-Fetch-Site half of the browserCsrf guard the dev-flow
// and sign-in routes use (routes/dev-flow.js, routes/cli-auth.js): a browser
// stamps every request with it, and only 'same-origin' means the Homeroom
// page sent it. There is no Origin comparison here on purpose: those routes
// compare against config.cliAuthOrigin, which is null on staging previews,
// and these routes must work there.
//
// - Header absent → allowed. Browsers that send it cannot be made to omit it;
//   its absence means a non-browser client (the native app's HTTP calls, the
//   CLI, a test) or a browser old enough to predate it.
// - 'none' → refused. It marks a navigation the user started themselves
//   (typed URL, bookmark), which never produces a POST or DELETE fetch, so
//   nothing legitimate is lost by treating it like any other non-same-origin
//   value.
// - 'same-site' / 'cross-site' → refused: exactly the requests this stops.
function sameOriginBrowserOnly(req, res, next) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}

module.exports = { sameOriginBrowserOnly };
