# Third-party software

Guide Builder ships these libraries in `vendor/`. Each keeps its own license; the license text is in the header of each file.

| File | Library | Version | License |
|---|---|---|---|
| `vendor/three/three.module.js`, `vendor/three/addons/*` | [three.js](https://github.com/mrdoob/three.js) | r160 | MIT |
| `vendor/jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 | MIT |
| `vendor/jszip.min.js` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT (dual-licensed MIT or GPLv3; used here under MIT) |
| `vendor/marked.esm.js` | [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT |
| `vendor/guide-viewer.html` | Guide Viewer (companion project) | — | MIT |

Guide Viewer loads three.js, JSZip, marked and [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 or MPL-2.0) from the jsDelivr CDN at run time.
