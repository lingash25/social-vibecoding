# public/fonts/albert-sans — the Albert Sans typeface, self-hosted

Albert Sans is the sans-serif of the **glass look**, an experiment that is
off by default (Settings › Experimental; the head's `window.Skin` sets
`data-skin="glass"` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the experiment off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/albert-sans`,
not from a CDN. The package is not a dependency: two font files do not
justify an entry in the lockfile. Two unicode subsets ship, latin and
latin-ext, with the package's own `unicode-range` lines, so a page in
English downloads one 31 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `AlbertSans-Variable.woff2` | `@fontsource-variable/albert-sans` | 5.3.0 | `files/albert-sans-latin-wght-normal.woff2` | `bsfVdNSWl/pAFd2Hfq8XgwkhepewcM/IHD7DGvVbBL4Ft//ceEbxy2Z3wnHn7Lot` | 32020 B |
| `AlbertSans-Variable-latin-ext.woff2` | `@fontsource-variable/albert-sans` | 5.3.0 | `files/albert-sans-latin-ext-wght-normal.woff2` | `AAOcwk+LOsokJ/KuZ+/KQnxSTj5hokVzxDCETugLthBwzx3X1LHMFmRHsp8C4vQD` | 23372 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/usted/Albert-Sans
