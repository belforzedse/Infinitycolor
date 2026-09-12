# Local package patches

## `react-instagram-stories@1.1.1`

Upstream: <https://github.com/ankit64jangir/react-instagram-stories> (MIT), published as a
minified `dist` only. The original TypeScript is recoverable from `dist/index.js.map`
(`sourcesContent`), which is where the "before" snippets below come from — read that map
before touching this patch.

The storefront and social Stories viewer (`packages/story-rail`) owns all playback-critical
behaviour through the package's `custom_component` extension point. These edits exist because
three of those responsibilities are unreachable from outside the package, plus three outright
lifecycle defects.

### Why each edit exists

**E1 — open effect (`StoryViewer`)**

```ts
// before
useEffect(() => {
  if (isOpen && !hasStartedLoadingRef.current) {
    hasStartedLoadingRef.current = true;
    setIsLoading(true);
    if (currentStory) preloadStoryItem(currentStory);
    setTimeout(() => {                      // never cleared
      setIsLoading(false);
      scrollPositionRef.current = window.scrollY;
      document.body.style.overflow = "hidden";
      timer.resume();
    }, 1500);                               // fixed gate, unrelated to media readiness
  } else if (!isOpen) { /* reset */ }
  return () => { document.body.style.overflow = ""; };
}, [isOpen, timer]);                        // `timer` is a new object every render
```

Three bugs. (a) Every open showed a 1.5 s spinner regardless of whether the media was ready.
(b) The timeout was never cleared, so closing the viewer within 1.5 s set
`document.body.style.overflow = "hidden"` *after* the cleanup had already run — leaving the
page permanently unscrollable — and resumed a timer on an unmounted viewer. (c) `timer`
changes identity on every render, so the effect re-ran constantly and its cleanup cleared the
scroll lock immediately after it was set.

Patched: the gate is gone (our renderer decides readiness), `scrollPositionRef` and the scroll
lock are set synchronously on open — `handleClose` scrolls back to `scrollPositionRef`, so
they cannot simply be dropped — and the deps are `[isOpen]`.

**E2 — external progress (`StoryViewer`, new `progress?: number` prop)**

The package derives progress from a wall clock (`useTimer`), never from media playback, and
`useEffect(() => timer.setDuration(currentStory?.duration ?? 5000), [timer, ...])` re-runs on
every render — so it overwrites any `controls.setDuration()` a custom component sets, ~60×/s.
There is no working duration adapter, and therefore no way to keep the bar in sync with a
video from outside.

Patched: when `progress` is supplied the live face renders it instead of `timer.progress`,
and the internal timer is made inert — `onComplete` is suppressed and `reset`/`resume` become
no-ops. Neutering only `onComplete` is not enough: `handleNext`/`finalizeCube` call
`timer.reset()`, which restarts the rAF chain and re-renders the whole viewer at 60 Hz after
every navigation. With the timer inert, the host also owns advancing the story.

**E3 — custom component props (`StoryItem`)**

```ts
// before
case "custom_component":
  const Component = item.component;
  return <div …><Component {...controls} /></div>;
```

Custom components received only `{pause, resume, next, prev, setDuration}` — no activeness.
During every cube transition and swipe, `renderFaceContent` mounts the adjacent faces with
`isActive={false}`, so the neighbouring stories' video components mounted, downloaded and
started playing, then unmounted ~350 ms later: duplicate downloads, overlapping players and
audio from a story the viewer had already left. `isPaused` was likewise unreachable, so
press-and-hold could not pause a custom renderer.

Patched to `<Component {...controls} item={item} isActive={isActive} isPaused={isPaused} />`.
Passing `item` also lets the host use a single module-level component type instead of
building a new component per render.

**E4 — remove desktop hover-pause (`onMouseEnter`/`onMouseLeave`)**

Hover set `isPaused`, which (because of the defect fixed by E2/E3) previously affected
nothing. Once `isPaused` actually reaches the renderer, hovering would freeze every desktop
story while the cursor rests over the content — which is where the cursor always is. Removing
it preserves the behaviour users have today.

**E5 — remove the page-visibility effect**

```ts
// before
useEffect(() => {
  if (!isPageVisible) handlePause();
  else if (isPageVisible && !isPaused) handleResume();   // unreachable: isPaused is true here
}, [isPageVisible, handlePause, handleResume, isPaused]);
```

The resume branch can never run, so a story paused by tabbing away stayed paused until the
user tapped. `packages/story-rail` handles `visibilitychange` itself; this removes the second
owner.

**E6 — type declarations** (`index.d.ts` / `index.d.cts`): `progress` on `StoryViewerProps`,
and a `CustomComponentProps` type reflecting E3.

### Notes

- Edits are applied to **`dist/index.js` and `dist/index.cjs`**, plus both `.d.ts` files.
  Jest resolves the package through `exports.require` → `index.cjs`, so patching only the ESM
  bundle would make unit tests exercise different code from the browser.
- Two older edits predate this work and are retained: a pointer-capture exclusion so buttons
  inside the viewer (mute, close) receive their own taps, and `isolation: isolate` on
  `.story-viewer-items` in `dist/styles.css`.
- `pnpm patch react-instagram-stories@1.1.1` starts from the **already-patched** state, so
  regenerating keeps every edit. The reproduction script lives at
  `packages/story-rail/scripts/apply-upstream-patch.mjs`; it asserts each edit matches exactly
  once before rewriting, so a bundle change on a version bump fails loudly instead of silently
  no-op'ing.

### When to drop this patch

Remove it if upstream (a) exposes externally-driven progress, (b) passes item/active/paused
state to custom components, and (c) fixes the open-effect timeout — or when `packages/story-rail`
stops depending on this package. Re-run the story-rail unit suite and
`apps/e2e/stories.playwright.config.ts` after any version bump.
