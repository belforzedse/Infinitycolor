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
| `NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT`   | `100`        |
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

Policy `1.2.0` is strong-first. A generic or unknown browser starts at
Standard/Standard/Standard, which preserves the complete essential carousel,
catalog, form, and commerce behavior. Static memory/core hints never
pre-downgrade it. A UA report on the explicit high-end admission list starts at
Enhanced/High/Enhanced before hydration; real runtime jank can immediately
begin stepping it down.

| Signal                                 | Constraint                                     |
| -------------------------------------- | ---------------------------------------------- |
| admitted high-end legacy UA            | Enhanced/High/Enhanced                         |
| `prefers-reduced-motion: reduce`       | Motion Minimal                                 |
| `prefers-reduced-transparency: reduce` | opaque/non-blurred surfaces                    |
| `saveData === true`                    | Media Economy                                  |
| `slow-2g`, `2g`, or `3g`               | Media Economy                                  |
| memory/core hints                      | ignored for initial classification and maximum |
| missing/invalid/unsupported value      | ignored; remains Standard                      |
| valid session constraint               | component-wise clamp                           |

The UA admission is a small allowlist, not a capability score or a security
boundary. No browser name, desktop/mobile label, GPU string, or broad
fingerprint-like score is used. Raw UA/model and hardware/network values are
never persisted or emitted.

## Persistence and privacy

`sessionStorage["infinity:adaptive-quality:v1"]` has a six-hour TTL and is
guarded by `try/catch`. It contains only schema/policy/build versions, expiry,
coarse tier constraint, fixed reasons, smooth-window counters, session
downgrade/severe booleans, and a random anonymous rollout bucket from 0 through 9999.

It never stores memory, core count, connection type, UA, UA-CH model, admitted
device family, URL, frame/task history, product, order, user, or account data.
Tabs are not synchronized. Expired, malformed, wrong-version, or invalid-tier
records are ignored. A build or policy version change invalidates the record.

## Runtime downgrade

One hierarchy is active per window:

1. Long Animation Frames when supported;
2. otherwise Long Tasks;
3. otherwise bounded `requestAnimationFrame`.

There is one active observation window. It runs for eight seconds after
hydration and each route commit, and five seconds after the first load of an
enhancement family. rAF is capped at 240 samples and ignores the first ten.
Hidden-tab work is stopped and hidden samples are discarded. Route generations
cancel stale callbacks, observers, and timers. Reference counting makes
start/stop idempotent under React Strict Mode.

| Observer  | Repeated trigger                                                                                          | Severe trigger                                                |
| --------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| LoAF      | three entries with duration at least 120 ms or blocking duration at least 50 ms within the bounded window | duration at least 300 ms or blocking duration at least 150 ms |
| Long Task | three entries at least 80 ms                                                                              | one entry at least 300 ms                                     |
| rAF       | after warm-up, at least five visible deltas over 50 ms and p95 over 40 ms                                 | none                                                          |

Each accepted trigger lowers one step in Motion, Media, Rendering order. A
15-second cooldown follows. The current route never upgrades. New accessibility
or Save-Data constraints apply immediately; removing them cannot enrich that
route. The component-wise session maximum persists so a later route cannot
oscillate above a demonstrated constraint.

## Promotion

Promotion is enabled only for a UA-admitted high-end device candidate. An
explicit high-end legacy UA starts at peak immediately under the strong-first
policy. This includes Safari's generic `iPhone` family token because Safari
does not expose the exact model. If runtime evidence shows that device is not
smooth, normal downgrade and session constraints take precedence.

A reduced Android UA that hides its model may become eligible only after its
UA-CH model matches the allowlist and the session completes:

- three consecutive smooth observation windows;
- at least two route generations;
- no downgrade or severe event in the session.

One later promotion applies on the next route, in Rendering, Media, Motion
order. Safe never jumps directly to Enhanced, and current
accessibility/network constraints remain maximums. A runtime downgrade or
severe event makes later promotion unreachable for the rest of the session.

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

JavaScript is a storefront requirement. The governor reduces JavaScript and
media intensity; it does not maintain a separate no-JavaScript application.
`Reveal` is visible in SSR, the first hydration render,
missing-IntersectionObserver, and Minimal states. Standard uses a bounded
IntersectionObserver/CSS transform. Every observer disconnects on route/tier
change and unmount.

`content-visibility:auto` is currently disabled for home merchandising because
paint containment clipped the intentional full-viewport newest/discounted
backgrounds on both desktop and mobile. It must not be reintroduced around a
full-bleed, anchor/focus, PLP, PDP, cart, checkout, or sticky-filter subtree.

## Chunk and media mapping

### Hero

- SSR/Safe/Minimal: one linked static first slide plus semantic links to other
  banner targets;
- Standard: one responsive native/CSS-controlled slider without Motion;
- Enhanced: dynamically imported Motion slider using `LazyMotion`, asynchronous
  `domAnimation`, `m`, `strict`, and `MotionConfig reducedMotion="user"`.

The responsive `<picture>` uses one discoverable LCP image; there are no
simultaneous CSS-hidden mobile and desktop trees.

### Product rails and PLP

Home rails and PLP render one responsive list/grid. The current 30-item PLP is
not virtualized. Filters, sorting, URL state, pagination, links, prices,
availability, and wishlist behavior remain tier-independent.

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
- High: adjacent image and richer zoom preloading are allowed.

On downgrade to Economy, video pauses, removes `src`, calls `load()`, and resets
zoom state. Observers disconnect on tier/route/unmount.

### GIF, social, and stories

Economy renders semantic linked/text shells and does not attach optional GIF,
video, or social preview sources. The top animated GIF waits until the critical
window/LCP load is complete even at richer tiers. Infinitygram's media package
waits for both eligibility and a near-viewport intersection; its linked shell
remains SSR-visible. Explicit interaction may attach a requested medium. Story
avatars and links remain; the existing viewer stays interaction-lazy.

## Telemetry

Telemetry uses existing Matomo and `useReportWebVitals`; no SDK or custom
dimension was added. It runs only after the existing analytics consent is
`granted`, fails silently, and may inherit only the tracker’s existing
pseudonymous association.

Allowed route groups are `home`, `plp`, `search`, `pdp`, `cart`, `checkout`,
`auth`, `account`, `blog`, and `other`. Payment/callback/results map to
`checkout`.

| Event                                 | Sampling                  |
| ------------------------------------- | ------------------------- |
| `adaptive_quality/tier_change`        | 100%                      |
| `adaptive_quality/route_summary`      | 25%; cart/checkout 100%   |
| `adaptive_quality/promotion_eligible` | 100% of eligible sessions |
| supported observer name/detail        | 1%                        |
| Web Vitals                            | 25%; cart/checkout 100%   |

Payloads contain final tiers, a coarse reason, aggregate sample/issue/severe
counts, Web Vitals, and fixed enhancement-family names. They exclude pathnames,
raw capabilities, raw timings/history, search text, product/order/payment/user
IDs, and new Matomo custom dimensions.

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

Unit tests cover classifier neutrality and thresholds, accessibility/network
constraints, persistence expiry/versioning/blocked storage/privacy, rollout
buckets, researched UA admission and rejection, UA-CH denial/contradiction,
promotion to peak, downgrade ordering/session carryover, bootstrap/admin
exclusion, footer-control clearance, and controller cleanup.

The dedicated Playwright config builds and runs with `next start`, compiles a
test-only adapter, and gates Chromium desktop/mobile, Firefox, and WebKit. It
does not reuse the legacy helper that ignores hydration attribute errors. The
suite captures attributes at bootstrap assignment, checks one hero/LCP tree,
forbidden Safe media/chunks against built chunk content, first-hydration
visibility, keyboard semantics, missing/blocked APIs, reduced preferences, test Enhanced,
runtime downgrade persistence, high-end-only promotion, narrow mobile
footer/nav geometry, admin exclusion, SnappPay failure isolation, and downgrade
during payment submit/redirect/callback/result.

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
E2E_WEB_SERVER_COMMAND='pnpm --filter @repo/frontend build && pnpm --filter @repo/frontend exec next start -p 2888' pnpm --filter @repo/e2e e2e:adaptive
pnpm --filter @repo/e2e e2e:smoke
pnpm --filter @repo/backend test:ci
pnpm --filter @repo/backend test:integration
git diff --check
```

The GitLab `e2e:adaptive` job is blocking for `dev` and `main`. Performance
artifacts remain non-blocking until thresholds are calibrated; browser and
commerce parity are blocking immediately.

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

| Local cold home trace             | Before      | After       | Change             |
| --------------------------------- | ----------- | ----------- | ------------------ |
| critical font requests            | 13          | 1           | 12 fewer            |
| critical decoded font bytes       | 742,080     | 41,724      | 700,356 fewer       |
| total critical decoded bytes      | 2,678,518   | 1,972,948   | 705,570 fewer       |
| critical decoded script bytes     | 1,389,327   | 1,389,295   | effectively stable |
| pre-load optional GIF/Lottie work | not allowed | none seen   | gate satisfied      |

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

After launch, redeploy force-safe and investigate when adaptive JS/hydration
errors exceed 0.5% of route views for 15 minutes with at least 200 samples, or
p75 LCP/INP regresses at least 15% or CLS rises 0.02 for two one-hour windows
with enough samples.

Roll back immediately for an adaptive-caused checkout/payment/redirect defect,
or checkout/payment failures rising by 0.5 percentage points or 20% relative for
30 minutes with at least 50 attempts.

Monitor continuously for 24 hours and review again at 72 hours: Web Vitals,
JS/hydration failures, downgrade frequency/reasons, forbidden-resource leakage,
add-to-cart/cart/checkout/payment errors, and conversion.

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
