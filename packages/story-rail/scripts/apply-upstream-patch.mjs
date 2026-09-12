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

const EDITS = [
  {
    id: 'E2a',
    note: 'StoryViewer accepts an external `progress` prop',
    find: /\(\{users:e,initialUserIndex:r,initialStoryIndex:s,isOpen:o,onClose:u,onStoryChange:d,classNames:l\}\)=>/g,
    repl: '({users:e,initialUserIndex:r,initialStoryIndex:s,isOpen:o,onClose:u,onStoryChange:d,classNames:l,progress:ICP})=>',
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
    src = src.replace(re, e.repl.replace(/REACT\./g, file.endsWith('.cjs') ? 'V.' : '').replace(/\bJSX\(/g, file.endsWith('.cjs') ? 'jsxRuntime.jsx(' : 'jsx('));
    console.log(`ok   ${file} ${e.id} — ${e.note}`);
  }
  // ICP/ICT must be declared: they are introduced as destructured prop + let-chain member.
  writeFileSync(path, src);
}
