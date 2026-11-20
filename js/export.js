// PDF and Markdown export.
import { allSteps, newPartsInStep, groupParts, stepNumber } from './model.js';

const NOTE_STYLE = {
  tip: { label: 'Tip', color: [47, 158, 68], bg: [235, 251, 238] },
  warning: { label: 'Warning', color: [224, 49, 49], bg: [255, 240, 240] },
  info: { label: 'Note', color: [28, 126, 214], bg: [231, 245, 255] },
};
const NOTE_EMOJI = { tip: 'Tip', warning: 'Warning', info: 'Note' };

/** ctx: {project, images: Map, renderStep(step, w, h) -> canvas, thumb(partId) -> canvas, holeCounts()} */
export function stepImageSources(ctx, step, w, h) {
  const out = [];
  if (step.useRender !== false) out.push({ canvas: ctx.renderStep(step, w, h) });
  for (const id of step.images || []) if (ctx.images.has(id)) out.push({ url: ctx.images.get(id) });
  return out;
}

// ====================================================================== Markdown
export async function buildMarkdown(ctx, { embed = false } = {}) {
  const { project: p } = ctx;
  const S = p.settings;
  const files = new Map(); // path -> dataURL
  const ref = (path, dataUrl) => {
    if (embed) return dataUrl;
    files.set(path, dataUrl);
    return path;
  };
  const L = [];
  L.push(`# ${p.meta.title}`, '');
  if (p.meta.subtitle) L.push(`*${p.meta.subtitle}*`, '');
  const by = [p.meta.author && `by ${p.meta.author}`, p.meta.version && `Version ${p.meta.version}`, p.meta.date].filter(Boolean).join(' · ');
  if (by) L.push(by, '');
  const cover = coverStep(p);
  if (cover) L.push(`![${mdEsc(p.meta.title)}](${ref('images/cover.png', ctx.renderStep(cover, S.renderW, S.renderH).toDataURL('image/png'))})`, '');

  if (S.toc) {
    L.push('## Contents', '');
    if (p.meta.intro || p.meta.requirements) L.push(`- [Before you start](#before-you-start)`);
    if (S.partsList && p.parts.length) L.push(`- [Parts](#parts)`);
    for (const sec of p.sections) {
      L.push(`- [${sec.title}](#${slug(sec.title)})`);
      for (const st of sec.steps) L.push(`  - [${stepHeading(p, st)}](#${slug(stepHeading(p, st))})`);
    }
    L.push('');
  }
  if (p.meta.intro || p.meta.requirements) {
    L.push('## Before you start', '');
    if (p.meta.intro) L.push(p.meta.intro.trim(), '');
    if (p.meta.requirements) L.push('### Requirements', '', p.meta.requirements.trim(), '');
  }
  const legend = usedHoleTypes(p);
  if (S.legend && legend.length) {
    L.push('### Hole legend', '', '| Marker | Type | Hardware | Count |', '|---|---|---|---|');
    for (const { t, n } of legend) L.push(`| ${swatchMd(t.color)} | ${t.name} | ${t.hardware || '-'} | ${n} |`);
    L.push('');
  }
  if (S.partsList && p.parts.length) {
    L.push('## Parts', '', '| | Part | Qty |', '|---|---|---|');
    for (const { part, qty } of groupParts(p.parts)) {
      const img = ref(`parts/${fileSafe(part.name)}.png`, ctx.thumb(part.id).toDataURL('image/png'));
      L.push(`| <img src="${img}" width="96"> | ${part.name} | ${qty} |`);
    }
    L.push('');
  }
  for (const sec of p.sections) {
    L.push(`## ${sec.title}`, '');
    if (sec.intro) L.push(sec.intro.trim(), '');
    const secParts = sectionParts(p, sec);
    if (secParts.length) {
      L.push('**Parts in this section:** ' + groupParts(secParts).map(({ part, qty }) => `${part.name}${qty > 1 ? ` ×${qty}` : ''}`).join(', '), '');
    }
    const hw = sectionHardware(sec);
    if (hw.length) L.push('**Hardware:** ' + hw.map((h) => `${h.qty}× ${h.name}`).join(', '), '');
    for (const st of sec.steps) {
      const n = stepNumber(p, st.id);
      L.push(`### ${stepHeading(p, st)}`, '');
      const srcs = stepImageSources(ctx, st, S.renderW, S.renderH);
      srcs.forEach((s, i) => {
        const url = s.canvas ? s.canvas.toDataURL('image/png') : s.url;
        const ext = (/^data:image\/(\w+)/.exec(url) || [, 'png'])[1].replace('jpeg', 'jpg');
        L.push(`![Step ${n}](${ref(`images/step-${pad(n)}${i ? '-' + (i + 1) : ''}.${ext}`, url)})`, '');
      });
      const np = newPartsInStep(p, st.id);
      if (np.length) L.push('**Parts:** ' + groupParts(np).map(({ part, qty }) => `${part.name}${qty > 1 ? ` ×${qty}` : ''}`).join(', '), '');
      if (st.hardware?.length) L.push('**Hardware:** ' + st.hardware.map((h) => `${h.qty}× ${h.name}`).join(', '), '');
      if (st.text) L.push(st.text.trim(), '');
      for (const nt of st.notes || []) if (nt.text) L.push(`> **${NOTE_EMOJI[nt.kind] || 'Note'}:** ${nt.text.trim().replace(/\n/g, '\n> ')}`, '');
    }
  }
  return { md: L.join('\n').replace(/\n{3,}/g, '\n\n'), files };
}

export async function exportMarkdownZip(ctx) {
  const { md, files } = await buildMarkdown(ctx);
  const zip = new JSZip();
  const name = fileSafe(ctx.project.meta.title || 'guide');
  zip.file(`${name}.md`, md);
  for (const [path, url] of files) zip.file(path, url.split(',')[1], { base64: true });
  return zip.generateAsync({ type: 'blob' });
}

// ====================================================================== PDF
export async function exportPDF(ctx, onProgress = () => {}) {
  const { project: p } = ctx;
  const S = p.settings;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: S.pageSize === 'letter' ? 'letter' : 'a4' });
  const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
  const M = 15, CW = PW - 2 * M, BOTTOM = PH - 16;
  const accent = hexRgb(S.accent);
  const base = S.fontSize || 10;
  let y = M;
  const toc = [];

  const newPage = () => { doc.addPage(); y = M; };
  const ensure = (h) => { if (y + h > BOTTOM) newPage(); };
  const setFont = (style = 'normal', size = base, color = [33, 37, 41]) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); };
  const lh = (size) => size * 0.3528 * 1.38; // pt -> mm line height

  // ---- rich text
  const drawRuns = (runs, x, w, size, opts = {}) => {
    // word-wrap runs of {t,b,i,code}
    const words = [];
    for (const r of runs) for (const part of r.t.split(/(\s+)/)) if (part) words.push({ ...r, t: part });
    let line = [], lw = 0;
    const flushLine = () => {
      ensure(lh(size));
      let cx = x;
      for (const wd of line) {
        setFont(wd.code ? 'normal' : wd.b && wd.i ? 'bolditalic' : wd.b ? 'bold' : wd.i ? 'italic' : 'normal', size, opts.color);
        if (wd.code) doc.setFont('courier', 'normal');
        doc.text(wd.t, cx, y + size * 0.3528);
        cx += doc.getTextWidth(wd.t);
      }
      y += lh(size);
      line = []; lw = 0;
    };
    for (const wd of words) {
      setFont(wd.b ? 'bold' : wd.i ? 'italic' : 'normal', size);
      if (wd.code) doc.setFont('courier', 'normal');
      const ww = doc.getTextWidth(wd.t);
      if (/^\s+$/.test(wd.t)) { if (line.length) { line.push(wd); lw += ww; } continue; }
      if (lw + ww > w && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].t)) line.pop();
        flushLine();
      }
      if (ww > w) { // very long word: hard split
        let s = wd.t;
        while (s.length) {
          let n = s.length;
          while (n > 1 && doc.getTextWidth(s.slice(0, n)) > w) n--;
          line.push({ ...wd, t: s.slice(0, n) }); flushLine(); s = s.slice(n);
        }
        continue;
      }
      line.push(wd); lw += ww;
    }
    if (line.length) flushLine();
  };
  const drawMd = (md, x = M, w = CW, size = base) => {
    for (const b of mdBlocks(md)) {
      if (b.type === 'h') {
        y += 1.5;
        ensure(lh(size + 3) + 4);
        drawRuns(b.runs.map((r) => ({ ...r, b: true })), x, w, size + Math.max(0, 4 - b.level) * 1.5);
        y += 0.5;
      } else if (b.type === 'li') {
        const ind = 5 + b.indent * 5;
        ensure(lh(size));
        setFont('normal', size);
        doc.text(b.ordered ? `${b.num}.` : '•', x + ind - 4, y + size * 0.3528);
        drawRuns(b.runs, x + ind, w - ind, size);
        y += 0.6;
      } else if (b.type === 'quote') {
        const y0 = y;
        drawRuns(b.runs, x + 4, w - 4, size, { color: [80, 87, 94] });
        doc.setDrawColor(200); doc.setLineWidth(0.8); doc.line(x + 1, y0, x + 1, y);
        y += 1.5;
      } else if (b.type === 'hr') {
        ensure(4); doc.setDrawColor(210); doc.setLineWidth(0.2); doc.line(x, y + 2, x + w, y + 2); y += 4;
      } else {
        drawRuns(b.runs, x, w, size);
        y += 1.8;
      }
    }
  };
  const heading = (text, size = 18) => {
    ensure(lh(size) + 6);
    setFont('bold', size, [20, 24, 28]);
    for (const ln of doc.splitTextToSize(latin(text), CW)) { doc.text(ln, M, y + size * 0.3528); y += lh(size); }
    doc.setDrawColor(...accent); doc.setLineWidth(0.8); doc.line(M, y + 0.5, M + 24, y + 0.5);
    y += 5;
  };
  const addImage = async (src, x, maxW, maxH, center = true) => {
    let url, iw, ih;
    if (src.canvas) { url = src.canvas.toDataURL('image/jpeg', 0.9); iw = src.canvas.width; ih = src.canvas.height; }
    else { url = src.url; const im = await loadImg(url); iw = im.naturalWidth; ih = im.naturalHeight; }
    const s = Math.min(maxW / iw, maxH / ih);
    const w = iw * s, h = ih * s;
    ensure(h);
    const fmt = /^data:image\/png/.test(url) ? 'PNG' : 'JPEG';
    const xx = center ? x + (maxW - w) / 2 : x;
    doc.addImage(url, fmt, xx, y, w, h, undefined, 'FAST');
    doc.setDrawColor(222); doc.setLineWidth(0.2); doc.rect(xx, y, w, h);
    y += h;
    return { w, h };
  };
  const thumbCache = new Map();
  const thumbUrl = (id) => {
    if (!thumbCache.has(id)) thumbCache.set(id, ctx.thumb(id).toDataURL('image/jpeg', 0.9));
    return thumbCache.get(id);
  };
  const partsGrid = (groups, cell = 30) => {
    const cols = Math.max(1, Math.floor(CW / (cell + 4)));
    const capH = 8;
    groups.forEach((g, i) => {
      const c = i % cols;
      if (c === 0) { if (i) y += cell + capH + 3; ensure(cell + capH); }
      const x = M + c * (cell + 4);
      doc.setDrawColor(222); doc.setLineWidth(0.2); doc.setFillColor(255, 255, 255);
      doc.roundedRect(x, y, cell, cell, 1.5, 1.5, 'FD');
      doc.addImage(thumbUrl(g.part.id), 'JPEG', x + 1, y + 1, cell - 2, cell - 2, undefined, 'FAST');
      if (g.qty > 1) {
        doc.setFillColor(...accent); doc.roundedRect(x + cell - 10, y + 1.5, 8.5, 5, 1, 1, 'F');
        setFont('bold', 8, [255, 255, 255]); doc.text(`x${g.qty}`, x + cell - 5.75, y + 5, { align: 'center' });
      }
      setFont('normal', 7.5, [52, 58, 64]);
      const ln = doc.splitTextToSize(latin(g.part.name), cell).slice(0, 2);
      doc.text(ln, x + cell / 2, y + cell + 3, { align: 'center' });
    });
    if (groups.length) y += cell + capH + 3;
  };
  const chips = (items) => {
    if (!items.length) return;
    let x = M;
    const h = 6;
    ensure(h + 2);
    for (const it of items) {
      const t = latin(`${it.qty} x ${it.name}`);
      setFont('bold', 8.5, [33, 37, 41]);
      const w = doc.getTextWidth(t) + 6;
      if (x + w > M + CW) { x = M; y += h + 2; ensure(h + 2); }
      doc.setFillColor(241, 243, 245); doc.setDrawColor(206, 212, 218); doc.setLineWidth(0.2);
      doc.roundedRect(x, y, w, h, 1.5, 1.5, 'FD');
      doc.text(t, x + 3, y + 4.2);
      x += w + 2;
    }
    y += h + 3;
  };
  const noteBox = (nt) => {
    const st = NOTE_STYLE[nt.kind] || NOTE_STYLE.info;
    setFont('normal', base);
    const lines = doc.splitTextToSize(latin(stripMd(nt.text)), CW - 10);
    const h = lines.length * lh(base) + 9;
    ensure(h);
    doc.setFillColor(...st.bg); doc.setDrawColor(...st.color); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, h, 1.5, 1.5, 'F');
    doc.setFillColor(...st.color); doc.rect(M, y, 1.2, h, 'F');
    setFont('bold', base - 1, st.color); doc.text(st.label.toUpperCase(), M + 5, y + 5);
    setFont('normal', base, [33, 37, 41]);
    doc.text(lines, M + 5, y + 5 + lh(base));
    y += h + 3;
  };

  // ---------------------------------------------------------------- cover
  onProgress('Cover');
  doc.setFillColor(...accent); doc.rect(0, 0, PW, 6, 'F');
  y = 30;
  setFont('bold', 28, [20, 24, 28]);
  for (const ln of doc.splitTextToSize(latin(p.meta.title), CW)) { doc.text(ln, M, y); y += 11; }
  if (p.meta.subtitle) { setFont('normal', 14, [90, 98, 106]); for (const ln of doc.splitTextToSize(latin(p.meta.subtitle), CW)) { doc.text(ln, M, y); y += 7; } }
  y += 6;
  const cover = coverStep(p);
  if (cover) await addImage({ canvas: ctx.renderStep(cover, S.renderW, S.renderH) }, M, CW, PH - y - 45);
  setFont('normal', 11, [90, 98, 106]);
  const by = [p.meta.author && `by ${p.meta.author}`, p.meta.version && `Version ${p.meta.version}`, p.meta.date].filter(Boolean);
  by.forEach((t, i) => doc.text(latin(t), M, PH - 25 + i * 6));

  // ---------------------------------------------------------------- TOC placeholder
  const tocEntries = (p.meta.intro || p.meta.requirements ? 1 : 0) + (S.partsList && p.parts.length ? 1 : 0)
    + p.sections.reduce((a, s) => a + 1 + s.steps.length, 0);
  const tocPerPage = Math.floor((BOTTOM - M - 20) / 6.2);
  const tocPages = S.toc ? Math.ceil(tocEntries / tocPerPage) : 0;
  const tocStart = 2;
  for (let i = 0; i < tocPages; i++) doc.addPage();

  // ---------------------------------------------------------------- front matter
  if (p.meta.intro || p.meta.requirements || (S.legend && usedHoleTypes(p).length)) {
    newPage();
    if (p.meta.intro || p.meta.requirements) {
      toc.push({ t: 'Before you start', page: doc.getNumberOfPages(), lvl: 0 });
      heading('Before you start');
      if (p.meta.intro) drawMd(p.meta.intro);
      if (p.meta.requirements) { y += 2; drawMd('### Requirements\n' + p.meta.requirements); }
    }
    const legend = usedHoleTypes(p);
    if (S.legend && legend.length) {
      y += 4;
      ensure(20);
      setFont('bold', base + 3, [20, 24, 28]); doc.text('Hole legend', M, y + 4); y += 9;
      setFont('normal', base - 1, [90, 98, 106]);
      doc.text('Coloured rings in the pictures mark holes that take hardware.', M, y + 3); y += 7;
      for (const { t, n } of legend) {
        ensure(7);
        const c = hexRgb(t.color);
        doc.setDrawColor(...c); doc.setLineWidth(1.1); doc.circle(M + 3, y + 2.5, 2.2, 'S');
        setFont('bold', base, [33, 37, 41]); doc.text(latin(t.name), M + 9, y + 3.8);
        setFont('normal', base, [90, 98, 106]);
        doc.text(latin(`${t.hardware || '-'}`), M + 75, y + 3.8);
        doc.text(`${n} in this guide`, M + CW, y + 3.8, { align: 'right' });
        y += 7;
      }
    }
  }
  if (S.partsList && p.parts.length) {
    onProgress('Parts list');
    newPage();
    toc.push({ t: 'Parts', page: doc.getNumberOfPages(), lvl: 0 });
    heading('Parts');
    partsGrid(groupParts(p.parts), 32);
  }

  // ---------------------------------------------------------------- sections & steps
  const two = S.layout === 'two';
  for (const sec of p.sections) {
    newPage();
    toc.push({ t: sec.title, page: doc.getNumberOfPages(), lvl: 0 });
    heading(sec.title, 20);
    if (sec.intro) drawMd(sec.intro);
    const secParts = sectionParts(p, sec);
    if (secParts.length) {
      y += 2; ensure(12);
      setFont('bold', base + 1, [20, 24, 28]); doc.text('Parts in this section', M, y + 4); y += 8;
      partsGrid(groupParts(secParts), 24);
    }
    const hw = sectionHardware(sec);
    if (hw.length) {
      ensure(12);
      setFont('bold', base + 1, [20, 24, 28]); doc.text('Hardware', M, y + 4); y += 7;
      chips(hw);
    }
    let first = true, onPage = 0;
    for (const st of sec.steps) {
      const n = stepNumber(p, st.id);
      onProgress(`Step ${n}`);
      const maxH = two ? (BOTTOM - M) / 2 - 45 : 125;
      const srcs = stepImageSources(ctx, st, S.renderW, S.renderH);
      const firstH = !srcs.length ? 0 : srcs[0].canvas ? Math.min(srcs.length > 1 ? maxH * 0.7 : maxH, (CW * srcs[0].canvas.height) / srcs[0].canvas.width) : maxH * 0.7;
      // one step per page; or two per page (the first may share the section page when there is room)
      if (!two || onPage >= 2 || (first && y > PH * 0.45)) { newPage(); onPage = 0; }
      first = false;
      const pg = doc.getNumberOfPages();
      ensure(14 + firstH + (onPage ? 10 : 0)); // keep the header together with its picture
      if (doc.getNumberOfPages() !== pg) onPage = 0;
      if (two && onPage > 0) { y += 4; doc.setDrawColor(222); doc.setLineWidth(0.3); doc.line(M, y, M + CW, y); y += 6; }
      onPage++;
      toc.push({ t: stepHeading(p, st), page: doc.getNumberOfPages(), lvl: 1 });
      // header
      ensure(14);
      doc.setFillColor(...accent);
      setFont('bold', 11, [255, 255, 255]);
      const badge = `STEP ${n}`;
      const bw = doc.getTextWidth(badge) + 7;
      doc.roundedRect(M, y, bw, 8, 1.5, 1.5, 'F');
      doc.text(badge, M + 3.5, y + 5.6);
      setFont('bold', 14, [20, 24, 28]);
      doc.text(doc.splitTextToSize(latin(st.title || ''), CW - bw - 4)[0] || '', M + bw + 4, y + 6);
      y += 12;
      // images
      for (const s of srcs) { await addImage(s, M, CW, srcs.length > 1 ? maxH * 0.7 : maxH); y += 3; }
      // parts + hardware
      const np = groupParts(newPartsInStep(p, st.id));
      if (np.length) {
        ensure(30);
        setFont('bold', base - 0.5, [90, 98, 106]); doc.text('PARTS', M, y + 3); y += 5;
        partsGrid(np, two ? 16 : 20);
      }
      if (st.hardware?.length) {
        setFont('bold', base - 0.5, [90, 98, 106]); ensure(12); doc.text('HARDWARE', M, y + 3); y += 5;
        chips(st.hardware);
      }
      if (st.text) { y += 1; drawMd(st.text); }
      for (const nt of st.notes || []) if (nt.text) noteBox(nt);
    }
  }

  // ---------------------------------------------------------------- TOC fill
  if (tocPages) {
    let pg = tocStart, ty = M;
    doc.setPage(pg);
    const tocHead = () => {
      setFont('bold', 18, [20, 24, 28]); doc.text('Contents', M, ty + 6);
      doc.setDrawColor(...accent); doc.setLineWidth(0.8); doc.line(M, ty + 9, M + 24, ty + 9);
      ty += 16;
    };
    tocHead();
    toc.forEach((e, i) => {
      if (i && i % tocPerPage === 0) { pg++; doc.setPage(pg); ty = M; tocHead(); }
      setFont(e.lvl ? 'normal' : 'bold', e.lvl ? base : base + 1, e.lvl ? [52, 58, 64] : [20, 24, 28]);
      const x = M + e.lvl * 6;
      const t = doc.splitTextToSize(latin(e.t), CW - 20 - e.lvl * 6)[0];
      doc.text(t, x, ty + 4);
      doc.text(String(e.page), M + CW, ty + 4, { align: 'right' });
      doc.link(M, ty, CW, 6, { pageNumber: e.page });
      doc.setDrawColor(225); doc.setLineWidth(0.1);
      doc.setLineDashPattern([0.5, 1], 0);
      doc.line(x + doc.getTextWidth(t) + 2, ty + 4, M + CW - doc.getTextWidth(String(e.page)) - 2, ty + 4);
      doc.setLineDashPattern([], 0);
      ty += 6.2;
    });
  }

  // ---------------------------------------------------------------- footers
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    setFont('normal', 8, [134, 142, 150]);
    doc.text(latin(S.footer || p.meta.title), M, PH - 8);
    doc.text(`${i} / ${total}`, PW - M, PH - 8, { align: 'right' });
    doc.setDrawColor(230); doc.setLineWidth(0.2); doc.line(M, PH - 12, PW - M, PH - 12);
  }
  doc.setProperties({ title: p.meta.title, author: p.meta.author || '', creator: 'Guide Builder' });
  return doc.output('blob');
}

// ====================================================================== helpers
export function coverStep(p) {
  const steps = allSteps(p);
  return steps.find((s) => s.id === p.meta.coverStepId) || steps[steps.length - 1] || null;
}
function stepHeading(p, st) { return `Step ${stepNumber(p, st.id)}${st.title ? ': ' + st.title : ''}`; }
function sectionParts(p, sec) { return sec.steps.flatMap((st) => newPartsInStep(p, st.id)); }
function sectionHardware(sec) {
  const m = new Map();
  for (const st of sec.steps) for (const h of st.hardware || []) m.set(h.name, (m.get(h.name) || 0) + (+h.qty || 0));
  return [...m].map(([name, qty]) => ({ name, qty }));
}
export function usedHoleTypes(p) {
  const counts = new Map();
  for (const pt of p.parts) for (const h of pt.holes || []) if (h.type && !h.hidden) counts.set(h.type, (counts.get(h.type) || 0) + 1);
  return p.holeTypes.filter((t) => counts.has(t.id) && !t.hidden).map((t) => ({ t, n: counts.get(t.id) }));
}
const pad = (n) => String(n).padStart(2, '0');
export const fileSafe = (s) => (s || 'file').replace(/[^\w\- .]+/g, '_').trim().slice(0, 80) || 'file';
const slug = (s) => s.toLowerCase().replace(/[^\w\- ]+/g, '').trim().replace(/\s/g, '-');
const mdEsc = (s) => s.replace(/[[\]]/g, '');
const swatchMd = (c) => `<span style="color:${c}">◯</span> \`${c}\``;
const hexRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function loadImg(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }

/** Map characters outside Latin-1 to safe equivalents (standard PDF fonts are WinAnsi). */
export function latin(s) {
  return String(s ?? '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/•/g, '•')
    .replace(/[←-⇿]/g, '->').replace(/≈/g, '~').replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/[^\x00-\xFF•]/g, '?');
}
const stripMd = (s) => String(s || '').replace(/\*\*|__|`/g, '');

/** Minimal Markdown block parser used by the PDF renderer. */
export function mdBlocks(md) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push({ type: 'p', runs: runs(para.join(' ')) }); para = []; } };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)/.exec(line))) { flush(); out.push({ type: 'h', level: m[1].length, runs: runs(m[2]) }); continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); out.push({ type: 'hr' }); continue; }
    if ((m = /^(\s*)[-*+]\s+(.*)/.exec(line))) { flush(); out.push({ type: 'li', indent: Math.floor(m[1].length / 2), runs: runs(m[2]) }); continue; }
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)/.exec(line))) { flush(); out.push({ type: 'li', ordered: true, num: m[2], indent: Math.floor(m[1].length / 2), runs: runs(m[3]) }); continue; }
    if ((m = /^>\s?(.*)/.exec(line))) { flush(); out.push({ type: 'quote', runs: runs(m[1]) }); continue; }
    if (/^!\[/.test(line.trim())) continue;
    para.push(line.trim());
  }
  flush();
  return out;
}
function runs(text) {
  const out = [];
  const re = /(\*\*\*|\*\*|__|\*|_|`)/g;
  let b = false, i = false, code = false, last = 0, m;
  text = latin(text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
  while ((m = re.exec(text))) {
    const tok = m[1];
    if (code && tok !== '`') continue;
    if ((tok === '_' || tok === '__') && /\w/.test(text[m.index - 1] || '') && /\w/.test(text[m.index + tok.length] || '')) continue;
    if (m.index > last) out.push({ t: text.slice(last, m.index), b, i, code });
    last = m.index + tok.length;
    if (tok === '`') code = !code;
    else if (tok === '***') { b = !b; i = !i; }
    else if (tok === '**' || tok === '__') b = !b;
    else i = !i;
  }
  if (last < text.length) out.push({ t: text.slice(last), b, i, code });
  return out;
}
