# Infinity automatic adaptive quality

## Status and scope

The customer storefront uses an automatic, invisible presentation governor on
home, PLP/search/category, PDP, blog, auth, account, cart, checkout, order
callback, and payment-result routes. `/super-admin`, APIs, and `apps/social` are
excluded.

The launch configuration is:

| Flag                                                      | Launch value |
| --------------------------------------------------------- | ------------ |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED`           | `true`       |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE` | `true`       |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION`         | `true`       |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY`         | `true`       |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT`   | `10`         |
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE`        | `false`      |

These are build-time values. Changing one requires a new build and deployment,
a new build version, service-worker/cache verification, and CDN verification.
They are not a remote kill switch. Exact legacy rollback uses the previous
image artifact.

## Non-negotiable commerce invariant

Every tier renders one semantic SSR commerce experience. Adaptive state can
change only decoration, optional media, motion, speculative prefetching, and
enhancement chunks. It cannot change:

- product identity, price, availability, stock, variants, links, query strings,
  sorting, filters, or pagination;
- form fields, validation, authentication, account access, or focus order;
- cart contents, quantities, persistence, checkout payloads, gateway choice, or
  finalization;
- payment requests, redirects, callback verification, payment result, or
  reconciliation;
- ISR data, APIs, URLs, service-worker data, or cache keys.

The governor is outside commerce state and never keys or conditionally wraps it.
Production E2E triggers a downgrade during checkout submission and then proves
the gateway redirect, callback, and result still complete.

## Public interfaces

The framework-independent module is in
`apps/frontend/src/lib/adaptive-quality`. Its public API exposes:

- `getSnapshot()` and `subscribe()`;
- `useAdaptiveQuality()` through React `useSyncExternalStore`;
- `isEnhancementEligible()`;
- `noteEnhancementLoaded()`;
- `startAdaptiveObservationWindow()`.

The snapshot axes are:

| Axis      | Levels, poor to rich        | Controls                                                  |
| --------- | --------------------------- | --------------------------------------------------------- |
| Rendering | Safe, Standard, Enhanced    | glass/filter work, rich backgrounds, enhancement chunks   |
| Media     | Economy, Standard, High     | optional media attachment and speculative secondary media |
| Motion    | Minimal, Standard, Enhanced | decorative transitions, autoplay, gesture-rich motion     |

High-frequency performance entries and rAF deltas remain in the external
singleton; React subscribers are notified only when a coarse snapshot changes.

## Pre-hydration and SSR

The server always sends the same inexpensive semantic markup and never
classifies a browser. A synchronous root-head script has no imports or fetches.
It exits before storage access on disabled builds and `/super-admin`, catches
all failures, and writes only:

- `data-aq-scope="storefront"`;
- `data-aq-rendering`;
- `data-aq-media`;
- `data-aq-motion`;
- `data-aq-transparency`.

It publishes the validated result to
`window.__INFINITY_AQ_BOOTSTRAP__`. Only `<html>` has
`suppressHydrationWarning`. Structural gates render the same semantic fallback
during SSR and the first hydration render; richer imports mount only after
hydration and eligibility resolution.

`instrumentation-client.ts` preserves the existing Sentry client initialization
required by Next 16/Turbopack and records only cheap startup/navigation marks
for this feature. It does not classify or start adaptive observers.

## Initial classification

Policy `2.0.0` has three independent layers:

1. a deterministic device baseline;
2. a temporary runtime constraint;
3. reversible live preference/network overlays.

A desktop starts Enhanced/High/Enhanced before hydration when
`(hover: hover)` and `(pointer: fine)` match, `hardwareConcurrency >= 8`, and
`deviceMemory` is either unavailable or at least 8. Unknown, weaker,
touch-primary, and invalid reports start Standard/Standard/Standard. The
researched high-end mobile allowlist remains a second peak-admission path.

| Live signal                            | Effective constraint            |
| -------------------------------------- | ------------------------------- |
| `prefers-reduced-motion: reduce`       | Motion Minimal                  |
| `prefers-reduced-transparency: reduce` | opaque/non-blurred styling only |
| `saveData === true`                    | Media Economy                   |
| `slow-2g` or `2g`                      | Media Economy                   |
| `3g`                                   | Media Standard                  |
| `4g`, unknown, or unsupported network  | no network cap                  |

These live signals never mutate the stored runtime constraint. For example,
`3g -> 4g` restores Media Standard to High immediately when the device/runtime
ceiling permits it. No browser label, GPU string, or broad fingerprint-like
score is used. Raw CPU, memory, pointer, network, UA, and model values are never
persisted or emitted.

## Persistence and privacy

`sessionStorage["infinity:adaptive-quality:v2"]` is schema 2 and is guarded by
`try/catch`. It contains only schema/policy/build versions, fixed `createdAt`
and six-hour `expiresAt`, the anonymous rollout bucket, `runtimeConstraint`,
`penaltyExpiresAt`, consecutive smooth-window count, last accepted bad-event
timestamp, and one coarse reason.

Ordinary writes preserve `createdAt` and `expiresAt`; they cannot slide the
record lifetime forward. Runtime penalties expire 30 minutes after the last
accepted bad event. The v1 key is ignored and removed after a successful v2
bootstrap, so old permanent-lockout records cannot constrain v2.

It never stores memory, core count, connection type, UA, UA-CH model, admitted
device family, URL, frame/task history, product, order, user, or account data.
Tabs are not synchronized. Expired, malformed, wrong-version, or invalid-tier
records are ignored. A build or policy version change invalidates the record.

## Runtime downgrade

One hierarchy is active per window:

1. Long Animation Frames when supported;
2. otherwise Long Tasks;
3. otherwise bounded `requestAnimationFrame`.

There is one continuous visible observation accumulator per route. Its initial
window is eight seconds. An enhancement load extends that same window until
five seconds after the load, capped at fifteen seconds from the active window
start; collected samples and the observer are not replaced. rAF keeps a bounded
rolling sample and ignores the first ten values per evaluation. Hidden,
replaced, and unmounted windows do not count as smooth. Route generations cancel
stale callbacks, observers, and timers. Reference counting makes start/stop
idempotent under React Strict Mode.

| Observer  | Repeated trigger                                                                                          | Severe trigger                                                |
| --------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| LoAF      | three entries with duration at least 120 ms or blocking duration at least 50 ms within the bounded window | blocking duration at least 150 ms                             |
| Long Task | three entries at least 80 ms                                                                              | one entry at least 300 ms                                     |
| rAF       | after warm-up, at least five visible deltas over 50 ms and p95 over 40 ms                                 | none                                                          |

One LoAF with duration at least 300 ms but blocking duration below 150 ms is
diagnostic evidence, not an immediate severe downgrade. Each accepted trigger
lowers one step in Motion, Media, Rendering order and starts a 15-second
cooldown. Any accepted issue resets recovery evidence and extends the temporary
penalty, but no event creates a permanent session lock.

## Promotion

While the runtime constraint is below the device baseline, recovery windows run
back-to-back on the same visible route. After two consecutive clean completed
windows and at least 15 seconds since the last accepted issue, one axis promotes
toward the baseline in Rendering, Media, Motion order. The counter resets and
the process repeats until the baseline is reached. A route change is not
required.

Reduced Motion, Save Data, network, and transparency overlays remain
authoritative during every recovery step, but they do not lower the stored
runtime ceiling. Force-Safe overrides both downgrade and recovery.

An explicit high-end legacy mobile UA starts at peak immediately. A reduced
Android UA that hides its model may upgrade its baseline only after its UA-CH
model matches the allowlist; the high-entropy `model` value is not requested
for desktop or full Android UAs.

The conservative admission list, reviewed on 2026-07-27, is:

| Family            | Accepted UA or UA-CH report                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| Apple             | `iPhone` family                                                                      |
| Google            | Pixel 8 Pro, Pixel 9 Pro/Pro XL/Pro Fold, Pixel 10 Pro/Pro XL/Pro Fold               |
| Samsung Galaxy S  | S23/S23+/S23 Ultra, S24/S24+/S24 Ultra, S25/S25+/S25 Ultra, S26 Ultra model families |
| Samsung foldables | Galaxy Z Flip/Fold 5, 6, and 7 model families                                        |
| OnePlus           | OnePlus 12/12R and 13/13R model families                                             |
| Xiaomi            | Xiaomi 14 Ultra and 15 Ultra                                                         |

Android first checks an explicit legacy UA model, then requests the UA-CH
`model` high-entropy value when the reduced UA hides it. A generic reduced
Android model such as `K`, a desktop UA, an unlisted phone, a denied UA-CH
request, or contradictory reports are ineligible. UA spoofing is possible, so
admission is a performance optimization rather than a security boundary.

Safari does not expose an iPhone model in its UA and Safari 26 freezes the
reported iOS token. Therefore the site cannot truthfully distinguish an iPhone
13 Pro Max from another iPhone by UA. The `iPhone` family starts at peak, while
the live runtime observer is the guardrail that lowers a device which cannot
sustain it. Apple documents the iPhone 13 Pro Max as an A15 device with a
six-core CPU and 120 Hz ProMotion display; the generic Safari UA is the reason
the exact model cannot be asserted.

Primary references used for the list and detection contract:

- [WebKit Safari 26 UA behavior](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [Chrome User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)
- [Android WebKit UA metadata model field](https://developer.android.com/reference/androidx/webkit/UserAgentMetadata)
- [Apple iPhone 13 Pro Max specifications](https://support.apple.com/en-is/111870)
- [Google Pixel hardware specifications](https://support.google.com/pixelphone/answer/7158570)
- [Samsung Galaxy S26 Ultra model](https://www.samsung.com/uk/smartphones/galaxy-s/galaxy-s26-ultra-black-256gb-enterprise-edition-sm-s948bzkdeeb/)
- [Samsung Galaxy Z Fold7 model](https://www.samsung.com/us/smartphones/galaxy-z-fold7/)
- [OnePlus 13 specifications](https://www.oneplus.com/global/13/specs)
- [Xiaomi 15 Ultra specifications](https://www.mi.com/global/product/xiaomi-15-ultra/)

The list lives in
`apps/frontend/src/lib/adaptive-quality/high-end-user-agent.ts`. Changes require
primary vendor evidence, positive/negative unit cases, production Chromium
UA-CH coverage, and iPhone Safari verification. Raw reports and the matched
family are never persisted or included in Matomo payloads.

## Rendering and motion mapping

Safe and reduced-transparency styling uses opaque surfaces and removes
backdrop/SVG displacement filters, animated background work, large decorative
shadows, hover lift, and permanent `will-change`. The full-width
`جدیدترین ها` color haze is a required static backdrop at every tier.

Minimal Motion disables decorative animation while retaining focus,
loading/progress, validation, menus/modals, and confirmation feedback. It is not
a blanket `transition: none`.

For identical data, viewport, and UI state, the acceptance baseline is a frozen
Enhanced frame. Safe/Economy/Minimal keeps the same sections, imagery, card
counts, geometry, responsive composition, controls, and actions. It may replace
autoplay with manual navigation, moving media with its poster, blur with an
opaque/static surface, and decorative motion with its final state. Required
layout, responsive scaling, pagination, zoom, and interaction JavaScript stays
active at every tier.

Enhanced is the compatibility-rich path, with commit `93c39b74` (the last
pre-adaptive storefront baseline) serving as the behavioral reference. The
governor may make its implementation conditional or lazy, but must not silently
remove the baseline's visible motion, autoplay, hover feedback, or enabled
media. The current hero transition and home product-rail page transition use
the same timing/easing as that reference.

JavaScript is a storefront requirement. The governor reduces JavaScript and
media intensity; it does not maintain a separate no-JavaScript application.
`Reveal` is visible in SSR, the first hydration render,
missing-IntersectionObserver, and Minimal states. Standard uses a bounded
IntersectionObserver/CSS transform. Every observer disconnects on route/tier
change and unmount.

Safe/Economy/Minimal remains a fully interactive JavaScript storefront. It
keeps the same responsive product-rail limits and pagination, navigation,
variants, wishlist, forms, authentication, cart, checkout, callback, and
payment-result controllers. PDP zoom and Infinitygram's card/scaling layout
remain active. Optional Quick View, Share, video, and moving-media code can
defer until an explicit action, but the action remains available and functional
in Safe.

`content-visibility:auto` is currently disabled for home merchandising because
paint containment clipped the intentional full-viewport newest/discounted
backgrounds on both desktop and mobile. It must not be reintroduced around a
full-bleed, anchor/focus, PLP, PDP, cart, checkout, or sticky-filter subtree.

## Chunk and media mapping

### Hero

- SSR and first hydration: one linked responsive LCP image;
- Standard/Safe/Minimal: the complete responsive native/CSS-controlled slider
  with the same active image, pagination, links, dimensions, and shared active
  index, without autoplay or Motion;
- Enhanced: dynamically imported Motion slider using `LazyMotion`, asynchronous
  `domAnimation`, `m`, `strict`, and `MotionConfig reducedMotion="user"`. Once
  hydration confirms Enhanced eligibility, this compatibility-rich chunk is
  requested immediately rather than waiting for a later idle/LCP gate. The
  complete native slider remains visible while that chunk loads.

The responsive `<picture>` uses one discoverable LCP image; there are no
simultaneous CSS-hidden mobile and desktop trees. Runtime tier changes preserve
the active slide.

### Product rails and PLP

Home rails and PLP render one responsive list/grid. The current 30-item PLP is
not virtualized. Filters, sorting, URL state, pagination, links, prices,
availability, and wishlist behavior remain tier-independent.

Enhanced home product rails preserve the pre-adaptive page switch: the current
cards fade/scale out for 150 ms, the page changes, and the next cards fade/scale
in after a 50 ms handoff. Standard/Safe/Minimal commit the same page change
immediately with no decorative delay. A downgrade or hidden-tab transition
cancels timers, commits any pending page request, and restores an idle visible
track so animation can never block product access.

Quick View and Share imports are reached only after the corresponding explicit
click. High media may prewarm secondary product media from mouse/focus intent.
Safe/Economy is click-only and has no touch-hover speculation.

### Loaders and glass

An accessible CSS spinner is universal. The dotLottie package and JSON are
imported only while an Enhanced/Enhanced loader is actually visible; downgrade
stops the instance and conditional unmount lets the package destroy it. Blog
`GlassSurface` and its SVG/ResizeObserver work mount only in Enhanced and
normal-transparency state.

### PDP media

The active image, thumbnails, alt text, controls, and explicit access to every
medium remain available. The initial active product image keeps eager/high
discovery.

- Economy: no adjacent/zoom preload. Video has a real image poster and receives
  `src` only after explicit play.
- Standard: video source/metadata attaches only when the medium approaches the
  viewport.
- High: adjacent image preloading is allowed.

Zoom, thumbnails, navigation, keyboard access, pointer interaction, and touch
interaction stay available in Economy. Minimal Motion switches zoom/thumbnail
movement immediately. A user-started video remains attached across a later
downgrade; passive video attachment is still removed by the Economy render
path. Observers disconnect on tier/route/unmount.

### GIF, social, and stories

Enabled storefront GIFs are tier-independent: the top banner and merchandising
GIF slots keep their native animated image sources in Safe/Economy/Minimal and
are never replaced with adaptive text shells or unloaded on downgrade. Native
lazy loading may defer an off-screen transfer, but once the GIF enters loading
range it animates normally. Infinitygram uses the same `SocialPostCard`
components, images, variants, grid spans, and responsive scaling JavaScript at
every tier. Economy supplies cover images to those cards instead of attaching
video previews; higher media tiers may attach the preview with native
`preload="none"`. Story avatars and links remain; the existing viewer stays
interaction-lazy.

## Telemetry

Telemetry uses existing Matomo and `useReportWebVitals`; no SDK or custom
dimension was added. It runs only after the existing analytics consent is
`granted`, fails silently, and may inherit only the tracker’s existing
pseudonymous association.

Allowed route groups are `home`, `plp`, `search`, `pdp`, `cart`, `checkout`,
`auth`, `account`, `blog`, and `other`. Payment/callback/results map to
`checkout`.

| Event                            | Sampling                |
| -------------------------------- | ----------------------- |
| `adaptive_quality/tier_change`   | 100%                    |
| `adaptive_quality/recovery_step` | 100%                    |
| `adaptive_quality/route_summary` | 25%; cart/checkout 100% |
| Web Vitals                       | 25%; cart/checkout 100% |

The `useReportWebVitals` callback identity is stable; current route/tier context
is read through refs so route renders do not register duplicate reporters.
Payloads contain only fixed route group, from/to tiers, observer kind, coarse
transition reason, downgrade/recovery/overlay marker, aggregate
sample/issue/severe counters, and Web Vitals. They exclude pathnames, raw
capabilities/timing history, search text, product/order/payment/user IDs, and
new Matomo custom dimensions.

## CSP and browser support

The repository emits a report-only CSP with inline scripts currently allowed.
Candidate deployment must inspect the actual proxy/CDN response:

```bash
curl -sSIL https://candidate.example/ | grep -i content-security-policy
```

Any enforced upstream policy that blocks the root-head script or produces a CSP
violation is a release blocker. Authorize the exact bootstrap at deployment.
Nonce migration is intentionally outside this feature.

Supported older environments are lower-capability devices within Next 16’s
browser baseline. Unavailable modern APIs fall back neutrally to Standard.

## Service worker and caches

Quality never changes a service-worker cache key or response. The worker
explicitly bypasses `/_next/static`, `/_next/chunks`, and `/_next/image`.
Application caches are build-versioned.

`scripts/generate-build-version.js` idempotently injects each artifact’s version
into the Docker-build copy of `public/sw.js`. The tracked file retains
`v1-dev`. A new worker deletes old build-version cache namespaces on activation,
and `VersionCheck` offers a cache-clearing reload.

Acceptance includes:

1. a clean, new-context, service-worker-free Safe run;
2. a warm worker/cache upgrade run;
3. verification that the new `build-version.json`, client build version,
   session policy record, and active worker agree;
4. verification that old application caches are removed while hashed Next
   assets remain CDN-cacheable.

## Automated gates

Unit tests cover the desktop capability matrix, touch/unknown/invalid fallback,
reversible accessibility/network overlays, v1-to-v2 migration, fixed
expiry/versioning/blocked storage/privacy, researched mobile UA admission and
rejection, reduced-Android-only UA-CH access, LoAF blocking/repeated thresholds,
same-route two-window recovery, hidden-window rejection, enhancement-window
extension, penalty expiry, Force-Safe, bootstrap/controller parity, and stable
consent-granted Web Vitals reporting.

The dedicated Playwright config runs the production standalone output with a
test-only adapter and gates Chromium desktop/mobile, Firefox, and WebKit. It
does not reuse the legacy helper that ignores hydration attribute errors. The
suite captures attributes at bootstrap assignment, checks one hero/LCP tree,
forbidden Safe media/chunks against built chunk content, first-hydration
visibility, keyboard semantics, missing/blocked APIs, reduced preferences, test
Enhanced, runtime downgrade persistence, high-end-only promotion, narrow
mobile footer/nav geometry, admin exclusion, SnappPay failure isolation, and
downgrade during payment submit/redirect/callback/result.

`e2e:adaptive:parity` compares a settled Enhanced home frame with
Safe/Economy/Minimal at 390×844, 768×1024, 1280×800, and 1440×1100.
`e2e:adaptive:lowest` is run against a build compiled with
`NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE=true`; it covers home, PLP,
PDP gallery/zoom, cart persistence, static media, hidden reveals, and a
CPU-throttled/slower-network laptop flow.

Required local/release commands:

```bash
pnpm install --frozen-lockfile
pnpm --filter @repo/frontend check-types
pnpm --filter @repo/frontend lint
pnpm --filter @repo/frontend test:ci
pnpm --filter @repo/frontend build
ANALYZE=true pnpm --filter @repo/frontend build
pnpm --filter @repo/e2e check-types
pnpm --filter @repo/e2e install:browsers
mkdir -p apps/frontend/.next/standalone/apps/frontend/public apps/frontend/.next/standalone/apps/frontend/.next/static
cp -a apps/frontend/public/. apps/frontend/.next/standalone/apps/frontend/public/
cp -a apps/frontend/.next/static/. apps/frontend/.next/standalone/apps/frontend/.next/static/
E2E_WEB_SERVER_COMMAND='PORT=2888 HOSTNAME=127.0.0.1 node /absolute/repo/apps/frontend/.next/standalone/apps/frontend/server.js' pnpm --filter @repo/e2e e2e:adaptive
E2E_WEB_SERVER_COMMAND='PORT=2888 HOSTNAME=127.0.0.1 node /absolute/repo/apps/frontend/.next/standalone/apps/frontend/server.js' pnpm --filter @repo/e2e e2e:adaptive:parity
# Rebuild with NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE=true first.
E2E_WEB_SERVER_COMMAND='PORT=2888 HOSTNAME=127.0.0.1 node /absolute/repo/apps/frontend/.next/standalone/apps/frontend/server.js' pnpm --filter @repo/e2e e2e:adaptive:lowest
pnpm --filter @repo/e2e e2e:smoke
pnpm --filter @repo/backend test:ci
pnpm --filter @repo/backend test:integration
git diff --check
```

The GitLab `e2e:adaptive`, `e2e:adaptive:parity`, and
`e2e:adaptive:lowest` jobs are independently built and blocking for `dev` and
`main`. Performance artifacts remain non-blocking until thresholds are
calibrated; browser and commerce parity are blocking immediately.

## Baseline and measurement record

The pre-change local production build used Next 16.2.4:

| Evidence                 | Result       |
| ------------------------ | ------------ |
| compile                  | 9.9 seconds  |
| TypeScript phase         | 13.1 seconds |
| static generation        | 26/26 routes |
| `.next/static` aggregate | 11 MB        |

Selected manifests were preserved outside the worktree for same-session
comparison. This is build evidence, not field performance proof.

The same-session cold, service-worker-free home trace on the local production
server found the critical font waterfall was the clearest network regression.
Switching only the storefront to non-preloaded font declarations preserved the
same families and weights while letting each face load when CSS actually uses
it:

| Local cold home trace         | Before      | After     | Change             |
| ----------------------------- | ----------- | --------- | ------------------ |
| critical font requests        | 13          | 1         | 12 fewer           |
| critical decoded font bytes   | 742,080     | 41,724    | 700,356 fewer      |
| total critical decoded bytes  | 2,678,518   | 1,972,948 | 705,570 fewer      |
| critical decoded script bytes | 1,389,327   | 1,389,295 | effectively stable |
| pre-load optional Lottie work | not allowed | none seen | gate satisfied     |

This is local request/byte evidence, not a claim about field LCP or wall-clock
latency. Candidate and physical-device measurements remain required.

The following route/device matrix must be populated from a candidate deployment
before public launch. Record Next-16.2.12-only results separately from
adaptive-feature results.

| Route      | Tier/device/network | route JS | requests/media bytes | LCP discovery | LCP/INP/CLS | hydration/main thread | Long Tasks/LoAF |
| ---------- | ------------------- | -------- | -------------------- | ------------- | ----------- | --------------------- | --------------- |
| home       | pending             | pending  | pending              | pending       | pending     | pending               | pending         |
| PLP/search | pending             | pending  | pending              | pending       | pending     | pending               | pending         |
| PDP        | pending             | pending  | pending              | pending       | pending     | pending               | pending         |
| cart       | pending             | pending  | pending              | pending       | pending     | pending               | pending         |
| checkout   | pending             | pending  | pending              | pending       | pending     | pending               | pending         |

Required scenarios: desktop, mobile, 4x CPU slowdown, slow network, large
catalog, hidden and duplicate tabs, Safe/Standard/test Enhanced, and warm
service-worker upgrade.

Physical low-end Android and iPhone Safari evidence is still mandatory. If it
has not been recorded, public launch remains blocked; desktop emulation is not a
substitute.

## Release gates and operations

Block release for any commerce parity failure, hydration warning, forbidden Safe
request, duplicate hero/LCP request, inaccessible content, or leaked
observer/timer/player.

Roll out at 10% -> 25% -> 50% -> 100%, holding each stage for at least 24 hours
and 1,000 eligible sessions. Stop expansion for any commerce/hydration failure,
when more than 0.5% of capable desktops remain Safe after 60 clean seconds,
when fewer than 95% of clean downgraded sessions recover within 60 seconds, or
when route-group p75 LCP or INP regresses by more than 5%.

Roll back immediately for an adaptive-caused checkout/payment/redirect defect,
or checkout/payment failures rising by 0.5 percentage points or 20% relative for
30 minutes with at least 50 attempts.

Monitor continuously through each stage and review again at 72 hours: Web
Vitals, JS/hydration failures, downgrade/recovery frequency, forbidden-resource
leakage, add-to-cart/cart/checkout/payment errors, and conversion. Physical
low-end Android, iPhone Safari, and capable Windows/Linux/macOS evidence is
required before 100%.

## Exact rollback and cache procedure

1. Identify the last known-good immutable image
   `registry.cyandm.org/bel4/infinity/infinity-frontend:<commit-sha>`. Do not
   rebuild it.
2. On `/opt/infinity/frontend`, export the same `ENV_FILE`,
   `REGISTRY_IMAGE_BASE`, Redis image, and scale compose files used by the
   environment, but set `IMAGE_TAG=<known-good-commit-sha>`.
3. Pull that exact image and recreate the frontend compose services with the
   base, registry, and environment scale compose files. Verify every frontend
   health endpoint before restoring traffic.
4. Purge CDN HTML, `/sw.js`, and `/build-version.json`. Hashed `/_next/static`
   objects may remain.
5. The frontend Redis is dedicated. Remove only the handler prefix after
   confirming the target:

   ```bash
   docker compose --env-file "$ENV_FILE" exec -T frontend-redis \
     sh -c 'redis-cli --scan --pattern "infinity:*" | xargs -r redis-cli UNLINK'
   ```

6. In a fresh browser context, unregister the candidate worker/delete its
   application caches, load the known-good artifact, and confirm the active
   worker/build-version pair. Then test home, PDP, cart, checkout, redirect,
   callback, and payment result.

For a force-safe mitigation, build and deploy the same source with
`NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE=true`; this is slower than
artifact rollback and is not appropriate for an active payment defect.

## Known limitations and launch blockers

- Exact iPhone model detection is impossible from Safari's generic iPhone UA;
  Apple therefore starts the admitted iPhone family at peak and relies on live
  runtime downgrade rather than pretending to identify the model.
- The high-end Android list is intentionally conservative and needs periodic
  primary-source maintenance as vendors add model identifiers.
- Network/device hints are not universal; absence is neutral by design.
- Local build/type/unit tests are not production or real-device proof.
- The custom cache handler’s package peer graph reports an existing
  `@redis/client` peer mismatch because the app uses `redis@4.7.1`. The
  LRU/Redis runtime smoke and production build must pass; changing Redis is not
  bundled into this Next-only patch.
- Full candidate route metrics, actual proxy/CDN CSP response, warm-worker
  upgrade, low-end Android, and iPhone Safari results must be attached before
  public launch.
