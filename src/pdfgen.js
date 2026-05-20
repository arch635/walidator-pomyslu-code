"use strict";

// pdfgen.js - generator PDF z markdown raportu.
// Używa pdfkit + Noto Sans (polskie znaki, embedded TTF).
// Markdown parser: lekki, ręczny - tylko nagłówki (#, ##, ###), bullety (-,*),
// pogrubienia (**...**), kursywa (*...*), linki [tekst](url), code (`...`),
// horyzontalne linie (---). Bez tabel (nie używamy w raportach).

const fs = require("fs");
const path = require("path");

let PDFDocumentCache = null;
function PDFDocument() {
  if (!PDFDocumentCache) PDFDocumentCache = require("pdfkit");
  return PDFDocumentCache;
}

const FONT_REG = path.join(__dirname, "fonts", "NotoSans-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "fonts", "NotoSans-Bold.ttf");

// Render markdown raportu do PDF buffer.
// Zwraca Promise<Buffer> z gotowym PDF.
function renderMarkdownToPdf(markdown, opts = {}) {
  const title = opts.title || "Raport";
  const subtitle = opts.subtitle || "";

  return new Promise((resolve, reject) => {
    try {
      const Doc = PDFDocument();
      const doc = new Doc({
        size: "A4",
        margin: 50,
        info: {
          Title: title,
          Author: "theinnerspace.pl",
          Creator: "theinnerspace.pl"
        }
      });

      // Rejestracja polskich fontów (zastępują domyślne Helvetica).
      doc.registerFont("Regular", FONT_REG);
      doc.registerFont("Bold", FONT_BOLD);
      doc.font("Regular");

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header strony
      doc.font("Bold").fontSize(18).fillColor("#1a2a4a").text(title, { align: "left" });
      if (subtitle) {
        doc.moveDown(0.2);
        doc.font("Regular").fontSize(10).fillColor("#4a4a4a").text(subtitle, { align: "left" });
      }
      doc.moveDown(0.6);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e2e2de").lineWidth(0.5).stroke();
      doc.moveDown(0.8);
      doc.fillColor("#111").font("Regular").fontSize(11);

      renderMarkdown(doc, markdown);

      // Stopka na każdej stronie
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const footerY = doc.page.height - 35;
        doc.font("Regular").fontSize(8).fillColor("#888")
          .text("theinnerspace.pl  ·  raport wygenerowany automatycznie", 50, footerY, {
            width: 495,
            align: "center",
            lineBreak: false
          });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Bardzo prosty parser MD - linia po linii, bez zagnieżdżeń.
function renderMarkdown(doc, md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // pusta linia
    if (/^\s*$/.test(line)) {
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // horyzontalna linia
    if (/^---+\s*$/.test(line)) {
      doc.moveDown(0.3);
      const y = doc.y;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#e2e2de").lineWidth(0.5).stroke();
      doc.moveDown(0.5);
      i++;
      continue;
    }

    // nagłówki
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      const level = h[1].length;
      const text = stripInlineFormatting(h[2]);
      const sizes = { 1: 18, 2: 15, 3: 13, 4: 12, 5: 11, 6: 11 };
      const colors = { 1: "#1a2a4a", 2: "#1a2a4a", 3: "#1a2a4a" };
      doc.moveDown(level === 1 ? 0.6 : 0.4);
      doc.font("Bold").fontSize(sizes[level] || 11).fillColor(colors[level] || "#111")
        .text(text, { paragraphGap: 4 });
      doc.font("Regular").fontSize(11).fillColor("#111");
      i++;
      continue;
    }

    // bullety
    const b = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (b) {
      // zbierz grupę bulletów
      const items = [];
      while (i < lines.length) {
        const bm = lines[i].match(/^\s*[-*]\s+(.+?)\s*$/);
        if (!bm) break;
        items.push(bm[1]);
        i++;
      }
      for (const it of items) {
        doc.font("Regular").fontSize(11).fillColor("#111");
        const startY = doc.y;
        doc.text("•", 55, startY, { lineBreak: false, continued: false });
        // tekst od x=70, z inline formatting
        renderInline(doc, it, { x: 70, width: 475 });
      }
      doc.moveDown(0.2);
      continue;
    }

    // numbered list (1. ...)
    const n = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (n) {
      const items = [];
      let counter = 0;
      while (i < lines.length) {
        const nm = lines[i].match(/^\s*\d+\.\s+(.+?)\s*$/);
        if (!nm) break;
        items.push(nm[1]);
        i++;
      }
      counter = 0;
      for (const it of items) {
        counter++;
        doc.font("Regular").fontSize(11).fillColor("#111");
        const startY = doc.y;
        doc.text(`${counter}.`, 55, startY, { lineBreak: false, continued: false });
        renderInline(doc, it, { x: 70, width: 475 });
      }
      doc.moveDown(0.2);
      continue;
    }

    // paragraf - sklej do następnej pustej linii / specjalnej
    let para = line;
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*[-*]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i])
      && !/^---+\s*$/.test(lines[i])) {
      para += " " + lines[i];
      i++;
    }
    renderInline(doc, para, { width: 495 });
    doc.moveDown(0.3);
  }
}

// Render linii z inline formatting (**bold**, *italic*, `code`, [link](url)).
function renderInline(doc, text, opts = {}) {
  const x = opts.x;
  const width = opts.width || 495;

  // Tokenize: bardzo proste, regex by regex.
  // Najpierw zamień **...** na BOLD tokens.
  const tokens = tokenizeInline(text);

  // Render token po token, używając `continued: true` chain.
  // pdfkit nie wspiera mixed fontów w jednym call'u inaczej.
  doc.font("Regular").fontSize(11).fillColor("#111");
  let started = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const isLast = k === tokens.length - 1;
    const renderOpts = { continued: !isLast };
    if (!started && x !== undefined) {
      renderOpts.width = width;
    }
    if (t.type === "bold") {
      doc.font("Bold");
    } else if (t.type === "italic") {
      doc.font("Regular"); // brak italica w Noto Bold, fallback regular
    } else if (t.type === "code") {
      doc.font("Regular").fillColor("#444");
    } else if (t.type === "link") {
      doc.font("Regular").fillColor("#1a5a3e");
      renderOpts.link = t.url;
      renderOpts.underline = true;
    } else {
      doc.font("Regular").fillColor("#111");
    }
    if (!started && x !== undefined) {
      doc.text(t.text, x, doc.y, renderOpts);
      started = true;
    } else {
      doc.text(t.text, renderOpts);
    }
  }
  // Reset
  doc.font("Regular").fillColor("#111");
}

function tokenizeInline(text) {
  // Wyciągnij linki najpierw [tekst](url) -> placeholder
  const links = [];
  let s = String(text || "").replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    links.push({ text: t, url: u });
    return `\x01LINK${links.length - 1}\x01`;
  });

  // Code `...`
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, t) => {
    codes.push(t);
    return `\x02CODE${codes.length - 1}\x02`;
  });

  // Bold **...**
  const tokens = [];
  const boldSplit = s.split(/(\*\*[^*]+\*\*)/g);
  for (const part of boldSplit) {
    if (part.startsWith("**") && part.endsWith("**")) {
      tokens.push({ type: "bold", text: expandPlaceholders(part.slice(2, -2), links, codes) });
    } else {
      tokens.push({ type: "text", text: expandPlaceholders(part, links, codes) });
    }
  }
  // Rozbij teksty z linkami/code na sub-tokens.
  const final = [];
  for (const t of tokens) {
    if (t.type !== "text" && t.type !== "bold") {
      final.push(t);
      continue;
    }
    const parts = splitOnPlaceholders(t.text, links, codes, t.type);
    final.push(...parts);
  }
  return final;
}

function expandPlaceholders(s, _links, _codes) {
  // zwracamy bez ekspansji - placeholders pozostają, splitOnPlaceholders je obsługuje
  return s;
}

function splitOnPlaceholders(text, links, codes, baseType) {
  const re = /\x01LINK(\d+)\x01|\x02CODE(\d+)\x02/g;
  const result = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      result.push({ type: baseType, text: text.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      const l = links[parseInt(m[1], 10)];
      result.push({ type: "link", text: l.text, url: l.url });
    } else {
      const c = codes[parseInt(m[2], 10)];
      result.push({ type: "code", text: c });
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    result.push({ type: baseType, text: text.slice(last) });
  }
  return result.filter((t) => t.text && t.text.length > 0);
}

function stripInlineFormatting(s) {
  return String(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

module.exports = { renderMarkdownToPdf };
