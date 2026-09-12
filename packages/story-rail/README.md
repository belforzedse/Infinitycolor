# @repo/story-rail

The Stories rail and viewer shared by `apps/frontend` and `apps/social`.

## Ownership boundary

`react-instagram-stories@1.1.1` provides the chrome: the portal, the header and progress
bar layout, the 3D cube transition, tap/swipe gestures, keyboard handling and the focus
trap. **Everything playback-critical is owned here**, behind the package's
`custom_component` extension point:

| owned by this package | owned by the dependency |
|---|---|
| media readiness, buffering, autoplay, errors | portal, overlay, header layout |
| progress value and when it moves | progress bar rendering, cube transition |
| the decision to advance | tap/swipe/keyboard gestures, focus trap |
| prefetching, mute preference, visibility | story/user index bookkeeping |

That split is only possible because of the edits in `patches/README.md` — read it before
changing anything here or bumping the dependency.

## The playback model

`src/media/playback-machine.ts` is the single source of truth. One reducer, one state:

```
idle → loading → ready → playing ⇄ buffering → ended
                              ↘ error
                              ↘ fallback   (video decoded nothing → show the cover)
```

- `phase` describes the media; `holds` (`user` / `hidden` / `inactive`) describes who is
  preventing playback. They are separate because they are orthogonal — a story can be
  buffering *and* held by a press — and collapsing them is what creates the impossible
  combinations this replaces.
- Every media-originated action carries a **generation token**. The reducer drops anything
  whose generation is not current, so a settled `play()` promise, a late `canplay`, or a
  queued rAF callback from the story you just left cannot touch the new story.
- `advanceRequested` is set once and never cleared within a generation, which is what makes
  "advance exactly once" structural rather than a guard someone can forget.
- Progress runs only in `playing`/`fallback` with no holds, is monotonic, and for video is
  `currentTime / duration` — it cannot run ahead of what the viewer is actually seeing.

`src/media/StoryMediaSurface.tsx` is the single module-level renderer for every story type.
It remounts per story (`key={item.id}:{attempt}`) so each one gets a fresh `<video>` rather
than a mutated `src`, and inactive cube faces render the poster only — never a player.

## Running the tests

```bash
pnpm --filter @repo/story-rail test          # 45 unit tests (jsdom)
pnpm --filter @repo/story-rail check-types

# Real browsers: Chromium, Firefox, WebKit, plus mobile Chrome and mobile Safari.
# Self-contained — no Strapi, no Next, no third-party media host.
pnpm --filter @repo/e2e e2e:stories
pnpm --filter @repo/e2e e2e:stories --project webkit-desktop
```

The E2E suite drives `apps/e2e/stories-harness`, which mounts these same components with a
story list supplied through the URL, so every media response can be shaped (slow, stalled,
404, 500, undecodable) by route interception.

## Manual checks

Automated coverage handles the logic and three engines. These are the things a machine
here cannot cover — run them against a real build:

- [ ] **Branded Chrome on Windows/macOS with hardware HEVC.** Playwright's Chromium has no
      HEVC; branded Chrome 107+ on those platforms may decode it, which changes whether the
      cover fallback engages. Confirm both outcomes look right.
- [ ] **A real iPhone.** Check no fullscreen takeover, no native controls, that the mute
      button is reachable with a thumb, and that press-and-hold pauses cleanly.
- [ ] **A real Android device on a throttled connection.** Watch for a black flash between
      stories and for the spinner appearing only on perceptible stalls.
- [ ] **Sound.** Open a story, unmute, advance twice — the preference should persist across
      stories within the session and reset next time the viewer opens.
- [ ] **Network panel.** Opening the viewer should fetch the active story plus adjacent
      covers; the next video should show metadata-range requests, not a full body.
