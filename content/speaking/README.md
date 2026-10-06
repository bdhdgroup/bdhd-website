# The Speaking page

`bdhd.ae/speaking/` is built from this folder by `npm run build`, alongside the
Writing section.

- `index.md` - all the page copy: hero, introduction, proof strip, topics,
  formats, on-air line, invite text, bios, and the list of background photos
  and clips. Must be valid YAML: quote any value containing a colon followed
  by a space.
- `stages/` - one file per photo in the On stage grid.
- `media/` - source photos and clips. Anything listed in `index.md` or a
  stage file is read from here.
- `kit/` - headshots and `speaker-sheet.pdf` for the downloadable speaker kit.

## Add a photo to the On stage grid

1. Put the photo in `media/`.
2. Add a file to `stages/`, for example `stages/gulf-summit.md`:

   ```yaml
   ---
   photo: gulf-summit.jpg
   caption: Chairing a panel
   credit: Jane Smith
   order: 10
   ---
   ```

   `caption` describes the format, not the event. `credit` is optional;
   if set it shows as "Photo: Jane Smith". `order` sets the position,
   lowest first. The build crops each photo to 4:3 around the subject
   automatically.
3. `npm run build`.

## Change the moving background

Edit the `background:` list in `index.md`. Photos are cropped to 16:9 and
shown at 30% opacity behind the headline; clips must be MP4, muted, a few
seconds long and under 1.5MB. The first entry must be a photo: it is the only
image phones and reduced-motion visitors see. Use `hero_focus` to say where
that still should be anchored on a narrow screen.

## Change the speaker sheet

The PDF is generated from `index.md`. After editing the bio, topics or
formats, run:

```
npm run speaker-sheet
npm run build
```

The first command needs Google Chrome installed. The second publishes the new
PDF into the kit and rebuilds the zip.

## Enquiry form

With `form_endpoint` blank, the form opens the visitor's email app with their
details filled in, addressed to `invite_email`. To receive submissions
directly instead, sign up to a form service such as Formspree, then put the
endpoint URL it gives you in `form_endpoint` and rebuild.
