# Adding a piece of writing

Three steps.

1. Drop a new `.md` file into this folder. **The filename is the URL slug**, so
   `modular-rare-earth-refineries.md` publishes at `bdhd.ae/writing/modular-rare-earth-refineries/`.
   Use lowercase words separated by single hyphens.
2. Run the build from the repo root:

   ```
   npm run build
   ```

3. Commit and push as usual. GitHub Pages redeploys in a couple of minutes.

The build regenerates the whole Writing section every time, so it is safe to run
repeatedly. It writes `writing/index.html`, one folder per article, an Open Graph
image for each, `writing/feed.xml`, and refreshes `sitemap.xml`.

## Front matter template

Copy this to the top of a new file. Only `title`, `standfirst` and `date` are
required; leave anything else blank.

```yaml
---
title: Could Modular Rare Earth Refineries Break China's Stranglehold?
standfirst: One or two sentences that sell the piece. Shown on the index, under the headline, and as the search and social description.
date: 2026-09-10
topics: Rare earths, minerals, Gulf investment
published_by:            # e.g. Centre for Cities. Leave blank if this site is where it first appeared.
published_url:           # link to the original, if published_by is set
image:                   # path to a real photo, e.g. /writing/img/my-piece.jpg. Leave blank to generate a plate.
image_credit:            # shown small under the header image, e.g. Photo by Tom Fisk, Pexels
plate_seed:              # optional integer. Change it if you dislike the generated plate.
pullquote: A single sentence lifted from the piece. Appears as a large quote after the third paragraph.
facts: |
  Optional margin note, shown as "The facts behind this piece". Plain text.
  Indent continuation lines by two spaces.
draft: false             # true keeps it out of the build entirely
---
```

Everything after the closing `---` is the body, in normal markdown.

## House rules the build enforces

- **Single hyphens only.** An em dash or en dash anywhere in a body fails the
  build, with the filename and surrounding text in the error.
- **No bullet lists in article bodies.** The build warns if it finds one.
- **Quote any front matter value containing a colon followed by a space.**
  `title: Saudi Arabia Admits What the UK Never Could: "We Have No Ego"` is not
  valid YAML. Wrap it in single quotes and double any apostrophes inside:
  `title: 'Saudi Arabia Admits What the UK Never Could: "We Have No Ego"'`.
  If you forget, the build still works and prints a warning.

## Header images

Photos live in `writing/img/`, named after the slug, and are referenced from
front matter as `/writing/img/<slug>.jpg`. The build never deletes that folder,
so it is safe to drop files in there and rebuild.

`image_credit` appears in small muted type directly under the image. It is only
rendered when there is a real photo, never under a generated plate.

If `image` names a file that is not on disk, the build does not fail. It falls
back to the generated plate, prints a warning naming the missing path, and
carries on. Drop the file in and rebuild to pick it up.

The same artwork, photo or plate, is reused as the right-hand panel of the
article's Open Graph card.

## What the body supports

Paragraphs, `##` subheadings, links, `>` blockquotes, *italics* and **bold**.
Nothing else is needed.

A `## Sources` heading at the foot is treated specially: it gets an anchor, and
the "facts behind this piece" margin note links to it automatically.

## Things the build works out for itself

- **Reading time**, from the word count at 220 words per minute. Do not write it
  into the front matter.
- **Ordering.** Newest `date` first. The most recent piece becomes the hero on
  the index.
- **"Also published by"** strip on the index, from the distinct `published_by`
  values.
- **"More writing"**, the two most recent other pieces.
- **The plate**, the abstract illustration, generated from the slug or
  `plate_seed`. The same artwork is reused as the background of the Open Graph
  image.
