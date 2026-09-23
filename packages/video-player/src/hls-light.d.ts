// hls.js publishes its light build (no subtitles, alt audio, EME, CMCD — none used here)
// under `hls.js/light` without separate typings; the API is the full build's.
declare module "hls.js/light" {
  import Hls from "hls.js";
  export default Hls;
}
