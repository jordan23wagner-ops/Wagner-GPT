// resumeParse.js - self-contained PDF and DOCX text extraction (ported verbatim from the
// Job-Assistant extension's parsers.js). Pure browser APIs (DecompressionStream, TextDecoder,
// Uint8Array), zero external libraries. Exported as an ES module for the Wagner-GPT web app;
// the extraction internals below are unchanged from the extension so behavior stays identical.

function _latin1Decode(bytes) {
  var CHUNK = 0x8000;
  var out = '';
  for (var i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

async function _inflate(uint8, format) {
  return new Promise(function(resolve, reject) {
    try {
      var ds = new DecompressionStream(format);
      var writer = ds.writable.getWriter();
      var reader = ds.readable.getReader();
      var chunks = [];

      function readChunks() {
        reader.read().then(function(result) {
          if (result.done) {
            finish();
          } else {
            chunks.push(result.value);
            readChunks();
          }
        }).catch(function() {
          finish();
        });
      }

      function finish() {
        if (chunks.length === 0) { reject(new Error('empty')); return; }
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < chunks.length; j++) {
          out.set(chunks[j], off);
          off += chunks[j].length;
        }
        resolve(out);
      }

      writer.write(uint8).catch(function() {});
      writer.close().catch(function() {});
      readChunks();
    } catch (e) {
      reject(e);
    }
  });
}

function _trimStreamBytes(uint8) {
  var end = uint8.length;
  while (end > 0) {
    var b = uint8[end - 1];
    if (b === 0x0A || b === 0x0D || b === 0x20) end--;
    else break;
  }
  return uint8.subarray(0, end);
}

// Pure-JS RFC 1951 inflate — bypasses Chrome's strict DecompressionStream
// which throws on trailing bytes after compressed data (common in PDFs).
function _pureInflate(src) {
  var p = 0, out = [], buf = 0, bits = 0;
  function readBits(n) {
    while (bits < n) { if (p >= src.length) return -1; buf |= src[p++] << bits; bits += 8; }
    var v = buf & ((1 << n) - 1); buf >>>= n; bits -= n; return v;
  }
  function readByte() { bits = 0; buf = 0; if (p >= src.length) return -1; return src[p++]; }

  var LENS = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  var LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DISTS = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  var DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  function buildTree(lengths) {
    var maxLen = 0;
    for (var i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    if (maxLen === 0) return null;
    var counts = new Uint16Array(maxLen + 1);
    for (var i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
    var offsets = new Uint16Array(maxLen + 1);
    for (var i = 1; i <= maxLen; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
    var table = new Uint16Array(lengths.length);
    for (var i = 0; i < lengths.length; i++) if (lengths[i]) table[offsets[lengths[i]]++] = i;
    return { counts: counts, table: table, maxLen: maxLen };
  }

  function decode(tree) {
    var code = 0, first = 0, idx = 0;
    for (var len = 1; len <= tree.maxLen; len++) {
      code |= readBits(1);
      var count = tree.counts[len];
      if (code < first + count) return tree.table[idx + (code - first)];
      idx += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  }

  // Fixed Huffman tables
  var fixedLitLens = new Uint8Array(288);
  for (var i = 0; i < 144; i++) fixedLitLens[i] = 8;
  for (var i = 144; i < 256; i++) fixedLitLens[i] = 9;
  for (var i = 256; i < 280; i++) fixedLitLens[i] = 7;
  for (var i = 280; i < 288; i++) fixedLitLens[i] = 8;
  var fixedDistLens = new Uint8Array(32);
  for (var i = 0; i < 32; i++) fixedDistLens[i] = 5;
  var fixedLitTree = buildTree(fixedLitLens);
  var fixedDistTree = buildTree(fixedDistLens);

  function inflateBlock(litTree, distTree) {
    while (true) {
      var sym = decode(litTree);
      if (sym < 0 || sym === 256) return;
      if (sym < 256) {
        out.push(sym);
      } else {
        sym -= 257;
        var len = LENS[sym] + readBits(LEXT[sym]);
        var dsym = decode(distTree);
        if (dsym < 0) return;
        var dist = DISTS[dsym] + readBits(DEXT[dsym]);
        var pos = out.length;
        for (var i = 0; i < len; i++) out.push(out[pos - dist + (i % dist)]);
      }
    }
  }

  var last = 0;
  while (!last) {
    last = readBits(1);
    var type = readBits(2);
    if (type === 0) {
      bits = 0; buf = 0;
      var len = src[p] | (src[p + 1] << 8); p += 4;
      for (var i = 0; i < len; i++) out.push(src[p++]);
    } else if (type === 1) {
      inflateBlock(fixedLitTree, fixedDistTree);
    } else if (type === 2) {
      var hlit = readBits(5) + 257;
      var hdist = readBits(5) + 1;
      var hclen = readBits(4) + 4;
      var codeLens = new Uint8Array(19);
      for (var i = 0; i < hclen; i++) codeLens[ORDER[i]] = readBits(3);
      var codeTree = buildTree(codeLens);
      var allLens = new Uint8Array(hlit + hdist);
      var ai = 0;
      while (ai < hlit + hdist) {
        var s = decode(codeTree);
        if (s < 16) { allLens[ai++] = s; }
        else if (s === 16) { var rep = readBits(2) + 3; var prev = ai > 0 ? allLens[ai - 1] : 0; for (var ri = 0; ri < rep; ri++) allLens[ai++] = prev; }
        else if (s === 17) { var rep = readBits(3) + 3; for (var ri = 0; ri < rep; ri++) allLens[ai++] = 0; }
        else if (s === 18) { var rep = readBits(7) + 11; for (var ri = 0; ri < rep; ri++) allLens[ai++] = 0; }
      }
      var litTree = buildTree(allLens.subarray(0, hlit));
      var distTree = buildTree(allLens.subarray(hlit));
      inflateBlock(litTree, distTree);
    } else {
      return null;
    }
  }
  return new Uint8Array(out);
}

async function _inflateZlib(uint8) {
  uint8 = _trimStreamBytes(uint8);
  // Try pure-JS inflate first (immune to Chrome's trailing-data strictness)
  try {
    // zlib format: 2-byte header, then raw deflate data
    if (uint8.length >= 2 && (uint8[0] & 0x0F) === 8) {
      var raw = uint8.subarray(2);
      var result = _pureInflate(raw);
      if (result && result.length > 0) return result;
    }
  } catch (e) {}
  // Raw deflate without header
  try {
    var result = _pureInflate(uint8);
    if (result && result.length > 0) return result;
  } catch (e) {}
  // Fall back to DecompressionStream
  try {
    return await _inflate(uint8, 'deflate');
  } catch (e) {
    try {
      return await _inflate(uint8, 'deflate-raw');
    } catch (e2) {
      return null;
    }
  }
}

function _decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&amp;/g, '&');
}

// ---------- DOCX ----------

function _docxXmlToText(xml) {
  // Convert structural elements into capturable text nodes so order is preserved.
  xml = xml.replace(/<w:tab\b[^>]*\/?>/g, '<w:t>\t</w:t>');
  xml = xml.replace(/<w:br\b[^>]*\/?>/g, '<w:t>\n</w:t>');
  xml = xml.replace(/<w:cr\b[^>]*\/?>/g, '<w:t>\n</w:t>');
  xml = xml.replace(/<\/w:p>/g, '<w:t>\n</w:t></w:p>');

  var re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  var out = '';
  var m;
  while ((m = re.exec(xml)) !== null) {
    out += _decodeXmlEntities(m[1]);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractDocxText(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var dv = new DataView(arrayBuffer);

  // Locate End Of Central Directory record.
  var eocd = -1;
  var minI = Math.max(0, bytes.length - 22 - 65536);
  for (var i = bytes.length - 22; i >= minI; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This does not look like a valid .docx file.');

  var cdOffset = dv.getUint32(eocd + 16, true);
  var cdCount = dv.getUint16(eocd + 10, true);
  var p = cdOffset;
  var target = null;
  var decoder = new TextDecoder();

  for (var n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var compSize = dv.getUint32(p + 20, true);
    var nameLen = dv.getUint16(p + 28, true);
    var extraLen = dv.getUint16(p + 30, true);
    var commentLen = dv.getUint16(p + 32, true);
    var localOffset = dv.getUint32(p + 42, true);
    var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === 'word/document.xml') {
      target = { method: method, compSize: compSize, localOffset: localOffset };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('Could not find document text inside the .docx file.');

  var lo = target.localOffset;
  if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('Corrupt .docx (bad local header).');
  var lnameLen = dv.getUint16(lo + 26, true);
  var lextraLen = dv.getUint16(lo + 28, true);
  var dataStart = lo + 30 + lnameLen + lextraLen;
  var compData = bytes.subarray(dataStart, dataStart + target.compSize);

  var xmlBytes;
  if (target.method === 0) {
    xmlBytes = compData;
  } else if (target.method === 8) {
    xmlBytes = await _inflate(compData, 'deflate-raw');
  } else {
    throw new Error('Unsupported compression in .docx file.');
  }

  var xml = new TextDecoder('utf-8').decode(xmlBytes);
  return _docxXmlToText(xml);
}

// ---------- PDF ----------

function _parseCMap(cmapText) {
  var map = {};
  var re;
  // beginbfchar: <srcCode> <dstUnicode>
  re = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  var block;
  while ((block = re.exec(cmapText)) !== null) {
    var pairs = block[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    if (!pairs) continue;
    for (var p = 0; p < pairs.length; p++) {
      var m = pairs[p].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (m) {
        var src = parseInt(m[1], 16);
        var dst = '';
        var dh = m[2];
        for (var d = 0; d < dh.length; d += 4) {
          dst += String.fromCharCode(parseInt(dh.substr(d, 4), 16));
        }
        map[src] = dst;
      }
    }
  }
  // beginbfrange: <start> <end> <dstStart>
  re = /beginbfrange\s*([\s\S]*?)endbfrange/g;
  while ((block = re.exec(cmapText)) !== null) {
    var ranges = block[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    if (!ranges) continue;
    for (var r = 0; r < ranges.length; r++) {
      var rm = ranges[r].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (rm) {
        var rStart = parseInt(rm[1], 16);
        var rEnd = parseInt(rm[2], 16);
        var rDst = parseInt(rm[3], 16);
        for (var rv = rStart; rv <= rEnd; rv++) {
          map[rv] = String.fromCharCode(rDst + (rv - rStart));
        }
      }
    }
  }
  return map;
}

function _pdfContentToText(cs, fontMaps) {
  var out = '';
  var pending = [];
  var inArray = 0;
  var i = 0;
  var n = cs.length;
  var currentFont = null;
  var lastNum1 = undefined;
  var lastNum2 = undefined;

  function flush() {
    if (pending.length) { out += pending.join(''); pending = []; }
  }

  function decodeHex(hex, bytesPerChar) {
    var result = '';
    for (var h = 0; h < hex.length; h += bytesPerChar * 2) {
      var code = parseInt(hex.substr(h, bytesPerChar * 2), 16);
      if (currentFont && fontMaps[currentFont] && fontMaps[currentFont][code] !== undefined) {
        result += fontMaps[currentFont][code];
      } else if (bytesPerChar === 1) {
        result += String.fromCharCode(code);
      } else if (code >= 32 && code < 0xFFFE) {
        result += String.fromCharCode(code);
      }
    }
    return result;
  }

  while (i < n) {
    var ch = cs[i];

    if (ch === '(') {
      var depth = 1;
      i++;
      var str = '';
      while (i < n && depth > 0) {
        var c = cs[i];
        if (c === '\\') {
          var nx = cs[i + 1];
          if (nx === 'n') { str += '\n'; i += 2; }
          else if (nx === 'r') { str += '\r'; i += 2; }
          else if (nx === 't') { str += '\t'; i += 2; }
          else if (nx === 'b') { str += '\b'; i += 2; }
          else if (nx === 'f') { str += '\f'; i += 2; }
          else if (nx === '(' || nx === ')' || nx === '\\') { str += nx; i += 2; }
          else if (nx === '\n') { i += 2; }
          else if (nx === '\r') { i += 2; if (cs[i] === '\n') i++; }
          else if (nx >= '0' && nx <= '7') {
            var oct = nx; i += 2; var k = 0;
            while (k < 2 && cs[i] >= '0' && cs[i] <= '7') { oct += cs[i]; i++; k++; }
            str += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else { str += nx; i += 2; }
        } else if (c === '(') { depth++; str += c; i++; }
        else if (c === ')') { depth--; if (depth > 0) str += c; i++; }
        else { str += c; i++; }
      }
      pending.push(str);
    } else if (ch === '<' && cs[i + 1] !== '<') {
      var j = cs.indexOf('>', i + 1);
      if (j < 0) { i++; continue; }
      var hex = cs.substring(i + 1, j).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length === 0) { i = j + 1; continue; }
      var bytesPerChar = (hex.length >= 4 && hex.length % 4 === 0) ? 2 : 1;
      pending.push(decodeHex(hex, bytesPerChar));
      i = j + 1;
    } else if (ch === '[') { inArray++; i++; }
    else if (ch === ']') { if (inArray > 0) inArray--; i++; }
    else if (ch === '/') {
      var nameStart = i + 1;
      while (nameStart < n && cs[nameStart] !== ' ' && cs[nameStart] !== '\n' && cs[nameStart] !== '\r' && cs[nameStart] !== '\t' && cs[nameStart] !== '/') nameStart++;
      var fontName = cs.substring(i + 1, nameStart);
      i = nameStart;
    } else if (ch === '-' || (ch >= '0' && ch <= '9') || ch === '.') {
      var start = i;
      if (ch === '-') i++;
      while (i < n && ((cs[i] >= '0' && cs[i] <= '9') || cs[i] === '.')) i++;
      var numVal = parseFloat(cs.substring(start, i));
      if (inArray) {
        if (numVal <= -100) pending.push(' ');
      }
      lastNum2 = lastNum1;
      lastNum1 = numVal;
    } else if (ch === 'T') {
      var op2 = cs.substr(i, 2);
      if (op2 === 'Tj' || op2 === 'TJ') { flush(); i += 2; }
      else if (op2 === 'Td' || op2 === 'TD') {
        flush();
        if (lastNum2 !== undefined && Math.abs(lastNum1) > 0.5) out += '\n';
        i += 2;
      }
      else if (op2 === 'T*') { flush(); out += '\n'; i += 2; }
      else if (op2 === 'Tf') {
        if (fontName) currentFont = fontName;
        i += 2;
      }
      else if (op2 === 'Tm') {
        flush();
        out += '\n';
        i += 2;
      }
      else i++;
    } else if (ch === "'" || ch === '"') { flush(); out += '\n'; i++; }
    else { i++; }
  }
  flush();
  return out;
}

async function _decompressStream(bytes, s, objPos) {
  try {
    var streamIdx = s.indexOf('stream', objPos);
    if (streamIdx < 0) return null;
    var endObj = s.indexOf('endobj', objPos);
    if (endObj >= 0 && endObj < streamIdx) return null;

    var dictStart = s.lastIndexOf('<<', streamIdx);
    var dict = dictStart >= 0 ? s.substring(dictStart, streamIdx) : '';

    var ds = streamIdx + 6;
    if (s[ds] === '\r') ds++;
    if (s[ds] === '\n') ds++;
    var ei = s.indexOf('endstream', ds);
    if (ei < 0) return null;

    var streamBytes = bytes.subarray(ds, ei);
    var content = null;
    if (dict.indexOf('FlateDecode') >= 0) {
      content = await _inflateZlib(streamBytes);
    } else if (dict.indexOf('/Filter') < 0) {
      content = streamBytes;
    }
    return content ? _latin1Decode(content) : null;
  } catch (e) {
    return null;
  }
}

async function extractPdfText(arrayBuffer) {
  var bytes = new Uint8Array(arrayBuffer);
  var s = _latin1Decode(bytes);

  // Build an index of object positions: objNum -> position in file
  var objIndex = {};
  var objRe = /(\d+)\s+0\s+obj/g;
  var om;
  while ((om = objRe.exec(s)) !== null) {
    objIndex[om[1]] = om.index;
  }

  // Find font resource mappings: /FontName objNum 0 R
  var fontToObj = {};
  var fontResRe = /\/Font\s*<<([\s\S]*?)>>/g;
  var resourceMatch;
  while ((resourceMatch = fontResRe.exec(s)) !== null) {
    var fontDict = resourceMatch[1];
    var fre = /\/(\w+)\s+(\d+)\s+0\s+R/g;
    var fmatch;
    while ((fmatch = fre.exec(fontDict)) !== null) {
      fontToObj[fmatch[1]] = fmatch[2];
    }
  }

  // For each font object, find its ToUnicode reference
  var objToToUnicode = {};
  for (var fn in fontToObj) {
    var fObjNum = fontToObj[fn];
    if (!objIndex[fObjNum]) continue;
    var fObjPos = objIndex[fObjNum];
    var fObjEnd = s.indexOf('endobj', fObjPos);
    if (fObjEnd < 0) fObjEnd = fObjPos + 2000;
    var fObjText = s.substring(fObjPos, fObjEnd);
    var tuRef = fObjText.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (tuRef) objToToUnicode[fn] = tuRef[1];
  }

  // Decompress each ToUnicode stream and parse its CMap
  var fontMaps = {};
  var cmapCache = {};
  for (var fn2 in objToToUnicode) {
    var tuObjNum = objToToUnicode[fn2];
    if (cmapCache[tuObjNum]) {
      fontMaps[fn2] = cmapCache[tuObjNum];
      continue;
    }
    if (!objIndex[tuObjNum]) continue;
    var cmapText = await _decompressStream(bytes, s, objIndex[tuObjNum]);
    if (cmapText && (cmapText.indexOf('beginbfchar') >= 0 || cmapText.indexOf('beginbfrange') >= 0)) {
      var cmap = _parseCMap(cmapText);
      cmapCache[tuObjNum] = cmap;
      fontMaps[fn2] = cmap;
    }
  }

  // Extract text from all content streams
  var collected = '';
  var pos = 0;

  while (true) {
    var si = s.indexOf('stream', pos);
    if (si < 0) break;
    if (si >= 3 && s.substr(si - 3, 3) === 'end') { pos = si + 6; continue; }

    var dictStart = s.lastIndexOf('<<', si);
    var dict = dictStart >= 0 ? s.substring(dictStart, si) : '';

    var ds = si + 6;
    if (s[ds] === '\r') ds++;
    if (s[ds] === '\n') ds++;
    var ei = s.indexOf('endstream', ds);
    if (ei < 0) break;

    var streamBytes = bytes.subarray(ds, ei);
    pos = ei + 9;

    var content = null;
    if (dict.indexOf('FlateDecode') >= 0) {
      try { content = await _inflateZlib(streamBytes); } catch (e) { content = null; }
    } else if (dict.indexOf('/Filter') < 0) {
      content = streamBytes;
    }
    if (!content) continue;

    var cs = _latin1Decode(content);
    if (cs.indexOf('Tj') >= 0 || cs.indexOf('TJ') >= 0) {
      collected += _pdfContentToText(cs, fontMaps) + '\n';
    }
  }

  return collected.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── ES-module surface ─────────────────────────────────────────────────────────────────────────
// extractResumeText(file): mirrors sidepanel.js:560 — .txt read directly, .pdf/.docx via the
// extractors above, .doc rejected. Returns cleaned plain text.
export async function extractResumeText(file) {
  const name = (file.name || '').toLowerCase();
  let text;
  if (name.endsWith('.pdf')) text = await extractPdfText(await file.arrayBuffer());
  else if (name.endsWith('.docx')) text = await extractDocxText(await file.arrayBuffer());
  else if (name.endsWith('.doc')) throw new Error('The old .doc format is not supported. Please save/export as .docx, .pdf, or paste text.');
  else text = await file.text();
  return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Read a File as a base64 data payload { name, type, b64 } so it can later be attached to ATS
// résumé uploads (mirrors the extension's resumeFile shape). Capped at 2 MB (LinkedIn's cap).
export const MAX_RESUME_FILE_BYTES = 2 * 1024 * 1024;
export function fileToStored(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_RESUME_FILE_BYTES) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const b64 = res.includes(',') ? res.split(',')[1] : res;
      resolve({ name: file.name, type: file.type, b64 });
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export { extractPdfText, extractDocxText };
