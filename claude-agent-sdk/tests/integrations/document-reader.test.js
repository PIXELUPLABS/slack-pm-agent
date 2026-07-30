import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  docxXmlToText,
  extractDocxText,
  extractPdfText,
  isDocx,
  isLegacyDoc,
  isPdf,
  isTextLike,
  readZipEntry,
} from '../../integrations/document-reader.js';

/**
 * Build a real (minimal) ZIP archive so the reader is exercised against the
 * actual format rather than a stubbed unzip.
 * @param {Array<{ name: string, body: Buffer, store?: boolean }>} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, body, store = false } of entries) {
    const data = store ? body : deflateRawSync(body);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(0, 14); // crc — unchecked by the reader
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** @param {string} bodyXml */
function docxBuffer(bodyXml) {
  return makeZip([
    { name: '[Content_Types].xml', body: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', body: Buffer.from(bodyXml, 'utf8') },
  ]);
}

describe('format detection', () => {
  it('recognizes PDFs by mimetype or extension', () => {
    assert.strictEqual(isPdf('application/pdf', 'x'), true);
    assert.strictEqual(isPdf('', 'Engagement.PDF'), true);
    assert.strictEqual(isPdf('text/plain', 'notes.txt'), false);
  });

  it('recognizes .docx and separates it from legacy .doc', () => {
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    assert.strictEqual(isDocx(docxMime, 'brief'), true);
    assert.strictEqual(isDocx('', 'brief.docx'), true);
    assert.strictEqual(isLegacyDoc('application/msword', 'old.doc'), true);
    // A .doc must NOT be treated as a .docx — it is an OLE file, not a ZIP.
    assert.strictEqual(isDocx('application/msword', 'old.doc'), false);
    assert.strictEqual(isLegacyDoc(docxMime, 'brief.docx'), false);
  });

  it('recognizes text-like files', () => {
    assert.strictEqual(isTextLike('text/markdown', ''), true);
    assert.strictEqual(isTextLike('', 'markdown'), true);
    assert.strictEqual(isTextLike('application/pdf', 'pdf'), false);
  });
});

describe('readZipEntry', () => {
  it('reads a deflated member via the central directory', () => {
    const zip = makeZip([
      { name: 'a.txt', body: Buffer.from('first', 'utf8') },
      { name: 'word/document.xml', body: Buffer.from('<w:p><w:t>hello</w:t></w:p>', 'utf8') },
    ]);
    assert.strictEqual(readZipEntry(zip, 'word/document.xml')?.toString(), '<w:p><w:t>hello</w:t></w:p>');
  });

  it('reads a stored (uncompressed) member', () => {
    const zip = makeZip([{ name: 'word/document.xml', body: Buffer.from('<w:t>plain</w:t>', 'utf8'), store: true }]);
    assert.strictEqual(readZipEntry(zip, 'word/document.xml')?.toString(), '<w:t>plain</w:t>');
  });

  it('returns null for a missing member and for non-zip bytes', () => {
    assert.strictEqual(readZipEntry(makeZip([{ name: 'a.txt', body: Buffer.from('x') }]), 'word/document.xml'), null);
    assert.strictEqual(readZipEntry(Buffer.from('not a zip at all'), 'word/document.xml'), null);
  });
});

describe('docxXmlToText', () => {
  it('joins runs and breaks paragraphs', () => {
    const text = docxXmlToText(
      '<w:p><w:r><w:t>Scope of </w:t><w:t>work</w:t></w:r></w:p><w:p><w:t>Phase 1</w:t></w:p>',
    );
    assert.strictEqual(text, 'Scope of work\nPhase 1\n');
  });

  it('maps tabs and line breaks to whitespace', () => {
    assert.strictEqual(docxXmlToText('<w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t>'), 'a\tb\nc');
  });

  it('decodes entities and keeps xml:space attributes intact', () => {
    assert.strictEqual(docxXmlToText('<w:t xml:space="preserve">Q&amp;A &lt;draft&gt; </w:t>'), 'Q&A <draft> ');
  });

  it('ignores field codes and other non-text elements', () => {
    // instrText carries Word field codes (e.g. page refs) — not document text.
    const text = docxXmlToText('<w:p><w:instrText>PAGEREF _Toc1</w:instrText><w:t>Real text</w:t></w:p>');
    assert.strictEqual(text, 'Real text\n');
  });
});

describe('extractDocxText', () => {
  it('extracts text from a .docx archive', () => {
    const buf = docxBuffer('<w:body><w:p><w:t>Deliverables</w:t></w:p><w:p><w:t>Due 2026-08-14</w:t></w:p></w:body>');
    const text = extractDocxText(buf);
    assert.match(text, /Deliverables/);
    assert.match(text, /Due 2026-08-14/);
  });

  it('points at .docx/PDF when the archive is not a Word document', () => {
    const buf = makeZip([{ name: 'other.xml', body: Buffer.from('<x/>', 'utf8') }]);
    assert.throws(() => extractDocxText(buf), /re-save it as \.docx or a PDF/);
  });

  it('reports an image-only document rather than returning nothing', () => {
    assert.throws(() => extractDocxText(docxBuffer('<w:body><w:drawing/></w:body>')), /no readable text/);
  });
});

describe('extractPdfText', () => {
  /** @param {any[]} content @param {string} [stopReason] */
  function fakeAnthropic(content, stopReason = 'end_turn') {
    return {
      messages: { create: mock.fn(async () => ({ content, stop_reason: stopReason })) },
    };
  }

  /** @param {string} [body] */
  function pdfBuffer(body = 'fake pdf body') {
    return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.from(body, 'latin1')]);
  }

  it('sends the PDF as a base64 document block and returns the transcription', async () => {
    const client = fakeAnthropic([{ type: 'text', text: 'Scope: brand refresh\nDue: 2026-09-01' }]);
    const text = await extractPdfText(pdfBuffer(), { filename: 'engagement.pdf', client });

    const [args] = client.messages.create.mock.calls[0].arguments;
    const doc = args.messages[0].content[0];
    assert.strictEqual(doc.type, 'document');
    assert.strictEqual(doc.source.type, 'base64');
    assert.strictEqual(doc.source.media_type, 'application/pdf');
    assert.strictEqual(doc.title, 'engagement.pdf');
    assert.ok(Buffer.from(doc.source.data, 'base64').subarray(0, 5).toString('latin1') === '%PDF-');
    assert.match(text, /brand refresh/);
  });

  it('rejects bytes that are not a PDF before spending a model call', async () => {
    const client = fakeAnthropic([{ type: 'text', text: 'should not happen' }]);
    await assert.rejects(() => extractPdfText(Buffer.from('<html>login</html>'), { client }), /missing %PDF header/);
    assert.strictEqual(client.messages.create.mock.callCount(), 0);
  });

  it('surfaces a model refusal instead of returning empty text', async () => {
    const client = fakeAnthropic([], 'refusal');
    await assert.rejects(() => extractPdfText(pdfBuffer(), { client }), /declined to transcribe/);
  });

  it('errors when the model returns no text', async () => {
    const client = fakeAnthropic([]);
    await assert.rejects(() => extractPdfText(pdfBuffer(), { client }), /No text could be read/);
  });
});
