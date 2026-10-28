/**
 * Reapplies the react-instagram-stories edits documented in patches/README.md.
 *
 *   pnpm patch react-instagram-stories@1.1.1
 *   node packages/story-rail/scripts/apply-upstream-patch.mjs <printed temp dir>
 *   pnpm patch-commit <printed temp dir>
 *
 * Every edit must match exactly once per bundle; anything else exits non-zero rather
 * than silently producing a no-op patch. `pnpm patch` starts from the already-patched
 * state, so run this only when regenerating from a clean upstream tarball or after a
 * version bump — and re-read the recovered source in dist/index.js.map first.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = process.argv[2];
// `V.` (cjs) / bare (esm) React namespace, and jsxRuntime. (cjs) / bare (esm) JSX runtime.
const R = (s) => s.replace(/REACT\\./g, '(?:V\\.)?').replace(/\bJSX\b/g, '(?:jsxRuntime\\.)?jsx');

const STORY_VIEWER_RUNTIME = readFileSync(
  new URL('./react-instagram-stories-story-viewer.runtime.txt', import.meta.url),
  'utf8',
).trim();

const EDITS = [
  {
    id: 'E0',
    note: 'interactive controls are excluded from viewer gesture capture',
    find: /n\.target\.closest\("\.story-viewer-overlay"\)\|\|_\.current\|\|/g,
    repl: 'n.target.closest(".story-viewer-overlay, button, a, input, select, textarea, [role=button], [contenteditable]")||_.current||',
  },
  {
    id: 'E2a',
    note: 'StoryViewer accepts an external `progress` prop',
    find: /\(\{users:e,initialUserIndex:r,initialStoryIndex:s,isOpen:o,onClose:u,onStoryChange:d,classNames:l\}\)=>/g,
    repl: '({users:e,initialUserIndex:r,initialStoryIndex:s,isOpen:o,onClose:u,onStoryChange:d,classNames:l,progress:ICP,dir:IDR="ltr",labels:ILA={}})=>',
  },
  {
    id: 'E2b',
    note: 'internal timer is inert while external progress drives the bar',
    find: /\$e=REACT\.useRef\(\),E=Qe\(\{duration:Be\.current\|\|K,onComplete:\(\)=>\$e\.current\?\.\(\),autoStart:false\}\)/g,
    repl: '$e=REACT.useRef(),ICT=Qe({duration:Be.current||K,onComplete:()=>{ICP===void 0&&$e.current?.()},autoStart:false}),E=ICP===void 0?ICT:{progress:ICT.progress,isPaused:ICT.isPaused,pause:ICT.pause,resume:()=>{},reset:()=>{},setDuration:ICT.setDuration}',
  },
  {
    id: 'E2c',
    note: 'live face renders the external progress when supplied',
    find: /children:Ue\(F,B,w,E\.progress,!n\)/g,
    repl: 'children:Ue(F,B,w,ICP??E.progress,!n)',
  },
  {
    id: 'E1',
    note: 'open effect: no 1500ms gate, no uncleared timeout, deps [isOpen] only',
    find: /REACT\.useEffect\(\(\)=>\(y&&!Ie\.current\?\(Ie\.current=true,Se\(true\),B&&Ee\(B\),setTimeout\(\(\)=>\{Se\(false\),Ae\.current=window\.scrollY,document\.body\.style\.overflow="hidden",E\.resume\(\);?\s*\},1500\)\):y\|\|\(/g,
    repl: 'REACT.useEffect(()=>(y&&!Ie.current?(Ie.current=true,Se(false),Ae.current=window.scrollY,document.body.style.overflow="hidden",B&&Ee(B)):y||(',
  },
  {
    id: 'E1b',
    note: 'open effect deps: drop the per-render `timer` dependency',
    find: /\}\),\[y,E\]\)/g,
    repl: '}),[y])',
  },
  {
    id: 'E3',
    note: 'custom components receive item/isActive/isPaused, not just controls',
    find: /children:JSX\(a,\{\.\.\.l\}\)/g,
    repl: 'children:JSX(a,{...l,item:e,isActive:r,isPaused:s})',
  },
  {
    id: 'E4',
    note: 'remove desktop hover-pause',
    find: /onMouseEnter:q,onMouseLeave:\$,/g,
    repl: '',
  },
  {
    id: 'E5',
    note: 'remove the broken page-visibility effect (it can never resume)',
    find: /REACT\.useEffect\(\(\)=>\{Pe\?Pe&&!H&&\$\(\):q\(\);?\s*\},\[Pe,q,\$,H\]\),/g,
    repl: '',
  },
  {
    id: 'E7a',
    note: 'progress bars accept localized accessibility labels',
    find: /\(\{progress:e,isActive:r,classNames:s\}\)=>\{let o=Math\.round\(e\*100\)/g,
    repl: '({progress:e,isActive:r,classNames:s,label:IPL})=>{let o=Math.round(e*100)',
  },
  {
    id: 'E7b',
    note: 'progress aria-label is localized when supplied',
    find: /"aria-label":`Story progress: \$\{o\}%`/g,
    repl: '"aria-label":IPL?.(o)??`Story progress: ${o}%`',
  },
  {
    id: 'E7c',
    note: 'progress group forwards labels to each bar',
    find: /\(\{total:e,currentIndex:r,progress:s,classNames:o\}\)=>JSX\("div",\{className:x\("story-progress-bars-container",o\?\.root\),children:Array\.from\(\{length:e\}\)\.map\(\(u,d\)=>JSX\(Te,\{progress:d<r\?1:d===r\?s:0,isActive:d===r,classNames:o\?\.bar\},d\)\)\}\)/g,
    repl: '({total:e,currentIndex:r,progress:s,classNames:o,labels:IPL})=>JSX("div",{className:x("story-progress-bars-container",o?.root),children:Array.from({length:e}).map((u,d)=>JSX(Te,{progress:d<r?1:d===r?s:0,isActive:d===r,classNames:o?.bar,label:IPL?.progress},d))})',
  },
  {
    id: 'E8a',
    note: 'RTL keyboard arrows follow reading order',
    find: /Ke\(\{onLeft:ae,onRight:Y,/g,
    repl: 'Ke({onLeft:IDR==="rtl"?Y:ae,onRight:IDR==="rtl"?ae:Y,',
  },
  {
    id: 'E8b',
    note: 'RTL tap zones follow reading order',
    find: /n\.clientX-p\.left<p\.width\/2\?ae\(\):Y\(\)/g,
    repl: '(n.clientX-p.left<p.width/2?(IDR==="rtl"?Y:ae):(IDR==="rtl"?ae:Y))()',
  },
  {
    id: 'E8c',
    note: 'RTL programmatic cube animation is mirrored',
    find: /let L=n==="next"\?-1:1;g\.style\.transform=re\(p,L\)/g,
    repl: 'let L=(n==="next"?-1:1)*(IDR==="rtl"?-1:1);g.style.transform=re(p,L)',
  },
  {
    id: 'E8d',
    note: 'RTL live drag direction is mirrored',
    find: /let S=M\.current,L=g\/S;L=Math\.max/g,
    repl: 'let S=M.current,L=g/S*(IDR==="rtl"?-1:1);L=Math.max',
  },
  {
    id: 'E8e',
    note: 'RTL released drag direction is mirrored',
    find: /p=\(n\.clientX-m\.startX\)\/g;p=Math\.max/g,
    repl: 'p=(n.clientX-m.startX)/g*(IDR==="rtl"?-1:1);p=Math.max',
  },
  {
    id: 'E8f',
    note: 'RTL drag mount direction is mirrored',
    find: /let S=\(p\.currentX-p\.startX\)\/m;S=Math\.max/g,
    repl: 'let S=(p.currentX-p.startX)/m*(IDR==="rtl"?-1:1);S=Math.max',
  },
  {
    id: 'E8g',
    note: 'portaled viewer root owns explicit direction',
    find: /Pt=(?:jsxRuntime\.)?jsxs\("div",\{ref:X,className:x\("story-viewer",l\?\.root\),role:"dialog"/g,
    repl: 'Pt=JSS("div",{ref:X,className:x("story-viewer",l?.root),dir:IDR,role:"dialog"',
  },
  {
    id: 'E8h',
    note: 'cube adjacent faces mirror in RTL',
    find: /style:g\("-90deg"\)/g,
    repl: 'style:g(IDR==="rtl"?"90deg":"-90deg")',
  },
  {
    id: 'E8i',
    note: 'cube next face mirrors in RTL',
    find: /style:g\("90deg"\)/g,
    repl: 'style:g(IDR==="rtl"?"-90deg":"90deg")',
  },
  {
    id: 'E9a',
    note: 'localized close label',
    find: /"aria-label":"Close story viewer"/g,
    repl: '"aria-label":ILA.close??"Close story viewer"',
  },
  {
    id: 'E9b',
    note: 'localized dialog label',
    find: /"aria-label":`Stories by \$\{F\?\.username\|\|"user"\}`/g,
    repl: '"aria-label":ILA.dialog?.(F?.username||"user")??`Stories by ${F?.username||"user"}`',
  },
  {
    id: 'E9c',
    note: 'localized viewer instructions',
    find: /children:"Instagram-style stories viewer\. Tap left side to go to previous story, right side to go to next story\. Swipe left or right to navigate between users\. Press Escape to close\."/g,
    repl: 'children:ILA.description??"Instagram-style stories viewer. Tap left side to go to previous story, right side to go to next story. Swipe left or right to navigate between users. Press Escape to close."',
  },
  {
    id: 'E9d',
    note: 'localized live announcement',
    find: /children:\["Viewing story ",w\+1," of ",se," by"," ",F\?\.username\]/g,
    repl: 'children:ILA.announcement?.(w+1,se,F?.username||"user")??["Viewing story ",w+1," of ",se," by"," ",F?.username]',
  },
  {
    id: 'E9e',
    note: 'viewer forwards labels to progress bars',
    find: /progress:v,classNames:l\?\.progressBars\}\)/g,
    repl: 'progress:v,classNames:l?.progressBars,labels:ILA})',
  },
  {
    id: 'E10',
    note: 'replace the viewer with the centralized Instagram-model gesture and direction runtime',
    find: /var we=[\s\S]*?\}\);var dt=/g,
    repl: `${STORY_VIEWER_RUNTIME}var dt=`,
  },
];

for (const file of ['dist/index.js', 'dist/index.cjs']) {
  const path = `${DIR}/${file}`;
  let src = readFileSync(path, 'utf8');
  for (const e of EDITS) {
    const re = new RegExp(R(e.find.source), 'g');
    const hits = src.match(re);
    if (!hits || hits.length !== 1) {
      console.error(`FAIL ${file} ${e.id}: expected 1 match, got ${hits ? hits.length : 0}`);
      process.exit(1);
    }
    const replacement = e.repl
      .replace(/REACT\./g, file.endsWith('.cjs') ? 'V.' : '')
      .replace(/\bJSX\(/g, file.endsWith('.cjs') ? 'jsxRuntime.jsx(' : 'jsx(')
      .replace(/\bJSS\(/g, file.endsWith('.cjs') ? 'jsxRuntime.jsxs(' : 'jsxs(')
      .replace(/\bJSF\b/g, file.endsWith('.cjs') ? 'jsxRuntime.Fragment' : 'Fragment')
      .replace(/\bPORTAL\(/g, file.endsWith('.cjs') ? 'reactDom.createPortal(' : 'createPortal(');
    src = src.replace(re, () => replacement);
    console.log(`ok   ${file} ${e.id} — ${e.note}`);
  }
  // ICP/ICT must be declared: they are introduced as destructured prop + let-chain member.
  writeFileSync(path, src);
}

for (const file of ['dist/index.d.ts', 'dist/index.d.cts']) {
  const path = `${DIR}/${file}`;
  let src = readFileSync(path, 'utf8');
  const componentMarker = '    component: ComponentType<StoryItemControls>;';
  if ((src.match(/    component: ComponentType<StoryItemControls>;/g) ?? []).length !== 1) {
    throw new Error(`FAIL ${file}: custom component marker changed`);
  }
  src = src.replace(componentMarker, '    component: ComponentType<CustomComponentProps>;');
  const unionMarker = 'type StoryItem = ImageStoryItem | VideoStoryItem | TextStoryItem | CustomComponentStoryItem;';
  if ((src.match(/type StoryItem = ImageStoryItem \| VideoStoryItem \| TextStoryItem \| CustomComponentStoryItem;/g) ?? []).length !== 1) {
    throw new Error(`FAIL ${file}: StoryItem union marker changed`);
  }
  src = src.replace(
    unionMarker,
    `${unionMarker}\ninterface CustomComponentProps extends StoryItemControls {\n    item: StoryItem;\n    isActive: boolean;\n    isPaused: boolean;\n}`,
  );
  const marker = 'interface StoryViewerProps {';
  if ((src.match(new RegExp(marker, 'g')) ?? []).length !== 1) {
    throw new Error(`FAIL ${file}: StoryViewerProps marker changed`);
  }
  src = src.replace(
    marker,
    `interface StoryViewerLabels {\n    dialog?: (username: string) => string;\n    close?: string;\n    description?: string;\n    progress?: (percent: number) => string;\n    announcement?: (current: number, total: number, username: string) => string;\n}\ninterface StoryViewerProps {`,
  );
  const propMarker = '    classNames?: StoryViewerClassNames;';
  if ((src.match(/    classNames\?: StoryViewerClassNames;/g) ?? []).length !== 1) {
    throw new Error(`FAIL ${file}: classNames prop marker changed`);
  }
  src = src.replace(
    propMarker,
    `${propMarker}\n    /** Host-owned 0..1 progress; supplying it disables the internal wall clock. */\n    progress?: number;\n    /** Explicit direction for the portaled viewer and its navigation semantics. */\n    dir?: 'rtl' | 'ltr';\n    labels?: StoryViewerLabels;`,
  );
  src = src.replace(
    'export { type AvatarClassNames,',
    'export { type CustomComponentProps, type StoryViewerLabels, type AvatarClassNames,',
  );
  writeFileSync(path, src);
}

{
  const path = `${DIR}/dist/styles.css`;
  let src = readFileSync(path, 'utf8');
  const close = '  right: 16px;';
  if ((src.match(/  right: 16px;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: close position marker changed');
  }
  src = src.replace(close, '  inset-inline-end: max(16px, env(safe-area-inset-right));');
  const origin = '  transform-origin: left;';
  if ((src.match(/  transform-origin: left;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: progress origin marker changed');
  }
  const fillBlock = `.story-progress-bar-fill {
  height: 100%;
  background: white;
${origin}
  transition: transform 0.1s linear;
  will-change: transform;
}`;
  if ((src.match(/\.story-progress-bar-fill \{[\s\S]*?will-change: transform;\n\}/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: progress fill block changed');
  }
  src = src.replace(
    fillBlock,
    `${fillBlock}\n\n.story-viewer[dir="rtl"] .story-progress-bar-fill {\n  transform-origin: right;\n}`,
  );
  const progress = '.story-progress-bars-container {\n  display: flex;';
  if ((src.match(/\.story-progress-bars-container \{\n  display: flex;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: progress container marker changed');
  }
  src = src.replace(
    progress,
    `.story-progress-bars-container {\n  display: flex;\n  direction: inherit;`,
  );
  const items = '.story-viewer-items {\n  position: relative;';
  if ((src.match(/\.story-viewer-items \{\n  position: relative;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: story items marker changed');
  }
  src = src.replace(items, '.story-viewer-items {\n  isolation: isolate;\n  position: relative;');

  const viewer = `.story-viewer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;`;
  if ((src.match(/\.story-viewer \{\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: viewer inset marker changed');
  }
  src = src.replace(
    viewer,
    `.story-viewer {
  position: fixed;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
  overscroll-behavior: none;
  direction: inherit;`,
  );
  src = src.replace('  animation: fadeIn 0.3s ease;', '  animation: fadeIn 160ms ease-out;');

  const viewport = `.story-viewer-cube-viewport {
  position: relative;
  width: 100%;`;
  if ((src.match(/\.story-viewer-cube-viewport \{\n  position: relative;\n  width: 100%;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: cube viewport marker changed');
  }
  src = src.replace(
    viewport,
    `.story-viewer-cube-viewport {
  position: relative;
  width: 100%;
  overflow: hidden;
  overscroll-behavior: none;
  direction: inherit;`,
  );

  const wrapper = `.story-viewer-cube-wrapper {
  position: relative;
  width: 100%;`;
  if ((src.match(/\.story-viewer-cube-wrapper \{\n  position: relative;\n  width: 100%;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: cube wrapper marker changed');
  }
  src = src.replace(
    wrapper,
    `.story-viewer-cube-wrapper {
  position: relative;
  width: 100%;
  direction: inherit;
  transform-origin: center center;`,
  );

  const header = `.story-viewer-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;`;
  if ((src.match(/\.story-viewer-header \{\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;/g) ?? []).length !== 1) {
    throw new Error('FAIL styles.css: header inset marker changed');
  }
  src = src.replace(
    header,
    `.story-viewer-header {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 0;
  direction: inherit;`,
  );
  src = src.replace(
    '  padding: 16px;\n  background: linear-gradient(',
    '  padding: max(12px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left));\n  background: linear-gradient(',
  );
  src = src.replace(
    `.story-viewer-user-info {
  display: flex;`,
    `.story-viewer-user-info {
  display: flex;
  direction: inherit;
  justify-content: flex-start;
  text-align: start;`,
  );
  src = src.replace('  top: 26px;', '  top: calc(max(12px, env(safe-area-inset-top)) + 10px);');
  src += `

.story-viewer[dir="rtl"] .story-viewer-close {
  inset-inline-end: max(16px, env(safe-area-inset-left));
}

.story-viewer-content,
.story-viewer-header,
.story-progress-bars-container,
.story-viewer-cube-viewport,
.story-viewer-cube-wrapper {
  direction: inherit;
}

.story-viewer img,
.story-viewer video,
.story-viewer svg,
.story-viewer .story-viewer-close {
  transform-style: flat;
}

@media (prefers-reduced-motion: reduce) {
  .story-viewer {
    animation: none !important;
  }
}
`;
  writeFileSync(path, src);
}
