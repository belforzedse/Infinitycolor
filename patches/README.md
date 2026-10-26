# Local package patches

## `@lottiefiles/dotlottie-react@0.19.4`

Upstream: <https://github.com/LottieFiles/dotlottie-web/tree/main/packages/react> (MIT).
The constructor already receives the initial speed. The React wrapper nevertheless calls
`setSpeed(speed ?? 1)` immediately in its passive effect. Production iPhone checkout events
reach that redundant call and throw a Rust/WASM borrow error, allowing a decorative loader
to reach the root error boundary.

The patch tracks the speed last supplied to the constructor/setter in a React ref. It skips
the initial/default no-op and repeated values, while preserving actual speed changes and
resetting an explicit speed to the default. It applies to the ESM export and legacy browser
bundle; their source maps are composed through the two edits so original source locations
remain available. No runtime versions or other player controls change.

`pnpm --filter @repo/e2e test:loader-wrapper` exercises the installed wrapper with a player
that throws if the redundant setter is invoked. It also verifies explicit speed updates.
The storefront separately contains player failures within its existing CSS loader fallback.
Recheck this regression and the loader/browser suites before removing or replacing the patch.

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

**E7 — localized accessibility labels**

`StoryViewerLabels` lets the host provide concise labels for the dialog, close action,
instructions, live story announcement, and each progress segment. Both declaration formats
and both runtime bundles expose the same contract, so Persian text is not hidden behind
hard-coded English strings.

**E8/E10 — Instagram interaction model through one direction adapter**

The portaled viewer root receives `dir` directly. `IC_createDirectionAdapter` is the only
place that translates physical input into logical item/owner actions; keyboard, tap zones,
drag release, cube targets, and face placement consume that same adapter.

| Physical input | RTL | LTR |
| --- | --- | --- |
| left tap / `ArrowLeft` | next item | previous item |
| right tap / `ArrowRight` | previous item | next item |
| swipe right | next owner | previous owner |
| swipe left | previous owner | next owner |
| first progress segment | right edge | left edge |
| active progress fill | right to left | left to right |

Item actions cut immediately and reset progress; they never start a cube. Horizontal swipes
skip the remaining items and navigate owners. In RTL the next face is staged at `-90deg` and
enters from the physical left while the wrapper rotates to `+90deg`; previous uses the exact
mirror. LTR keeps upstream physical placement (`next +90deg`, wrapper `-90deg`). Both next and
previous owner navigation restore that owner's remembered item index.

The transition state machine is explicit and observable as `data-transition-state`:

```text
idle → pressing → dragging-owner → snapping-owner → idle
                 ↘ dismissing ──────────────────────→ close / idle
```

A hold pauses immediately; releasing after 180 ms resumes without also firing a tap. Owner
drags follow the pointer one-to-one, commit at 28% width or 0.55 px/ms, damp to 22% movement
at the first/last owner, and settle in 320 ms. Completion comes from `transitionend`; a guarded
timeout exists only for browsers that fail to emit it. `pointercancel`, lost capture, reversal,
resize, and orientation changes always settle or return to a valid owner. Downward drags over
120 px dismiss. Reduced-motion keeps the same results with rotation and dismissal animation
removed.

**E9 — fully mirrored presentation, progress, and document lock**

Close positioning uses `inset-inline-end`; the progress row, header, cube viewport/wrapper,
faces, and content all receive or inherit the explicit viewer direction. Fills keep identical
timing and `will-change` in both directions, with a left origin in LTR and right origin in RTL.
The header applies safe-area insets; media, URLs, numbers, SVGs, and the close glyph are not
mirrored. Opening is a short backdrop fade only. Both `html` and `body` are locked with their
previous inline styles and scroll position restored on close (including React Strict Mode
effect replay), while the viewer suppresses overscroll and horizontal overflow. The fixed
root is physically anchored at `left: 0` and uses `100vw`, so a document-level stable
scrollbar gutter cannot leave a visible strip beside the portaled overlay in RTL.

### Notes

- Edits are applied to **`dist/index.js` and `dist/index.cjs`**, plus both `.d.ts` files.
  Jest resolves the package through `exports.require` → `index.cjs`, so patching only the ESM
  bundle would make unit tests exercise different code from the browser.
- The pointer-capture exclusion remains so buttons and links inside the viewer (mute, close,
  retry and CTA) receive their own gestures. `isolation: isolate` on `.story-viewer-items`
  keeps cube faces from leaking across stacking contexts. Only the active face receives
  `isActive`; adjacent faces remain poster-backed and cannot publish progress.
- `pnpm patch react-instagram-stories@1.1.1` starts from the **already-patched** state, so
  regeneration must use a clean upstream tarball (`--ignore-existing`). The readable runtime
  lives at `packages/story-rail/scripts/react-instagram-stories-story-viewer.runtime.txt`; the
  reproduction script injects it into ESM and CommonJS, then updates both declaration bundles
  and CSS. Every upstream marker and the complete viewer replacement must match exactly once,
  so an incompatible artifact fails loudly instead of silently no-op'ing.

### When to drop this patch

Remove it if upstream (a) exposes externally-driven progress, (b) passes item/active/paused
state to custom components, and (c) fixes the open-effect timeout — or when `packages/story-rail`
stops depending on this package. Re-run the story-rail unit suite and
`apps/e2e/stories.playwright.config.ts` after any version bump.
