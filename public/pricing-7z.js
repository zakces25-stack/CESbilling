/*
 * pricing-7z.js - dependency-free .7z reader for the CES pricing desk.
 *
 * TotalEnergies (and possibly other suppliers) send weekly pricebooks as .7z
 * archives. This file lets the browser page read them directly: it parses the
 * archive held in memory (a Uint8Array) and hands each file's bytes to a
 * callback. It is plain ES2019 with no dependencies and no WASM, so the exact
 * same file runs as a classic <script> (window.SevenZip) and under Node via
 * require() for testing.
 *
 * What it reads:
 *   - the signature header (with its CRC) and the main header, either plain
 *     (kHeader) or itself compressed (kEncodedHeader, which 7-Zip uses by
 *     default), checking the header CRCs;
 *   - PackInfo / UnPackInfo / SubStreamsInfo, solid and non-solid archives
 *     (one or many folders), empty files, directories, UTF-16 names;
 *   - coders: Copy (00), LZMA (030101) and LZMA2 (21), each a single-coder
 *     folder. Every file's CRC32 is checked before its bytes are handed over.
 *
 * What it refuses, with an Error whose message names the problem (and whose
 * .code is one of the SEVENZIP_* codes below): encrypted archives (7zAES),
 * branch filters (BCJ, BCJ2, ARM, ARM64, ...), Delta, PPMd, BZip2, Deflate
 * and any other coder, chains of coders, split (multi-volume) or truncated
 * archives. A refusal is raised before any file is handed to onFile, so a
 * caller never gets partial output without an exception.
 *
 * Public API (see the bottom of the file for details):
 *   SevenZip.list(u8)               -> [{ name, size, isDir, crc, folderIndex }]
 *   SevenZip.extract(u8, options)   -> Promise<{ files: [names], ms }>
 */
(function (root) {
  'use strict';

  var VERSION = '2026-11-03.1';

  // ------------------------------------------------------------------------
  // Errors. Every failure is an Error with a stable .code so the page can
  // decide what to show; the message itself is written for desk staff.
  // ------------------------------------------------------------------------
  var E_NOT_7Z = 'SEVENZIP_NOT_7Z';
  var E_TRUNCATED = 'SEVENZIP_TRUNCATED';
  var E_CORRUPT = 'SEVENZIP_CORRUPT';
  var E_CRC = 'SEVENZIP_CRC';
  var E_ENCRYPTED = 'SEVENZIP_ENCRYPTED';
  var E_UNSUPPORTED = 'SEVENZIP_UNSUPPORTED';
  var E_TOO_BIG = 'SEVENZIP_TOO_BIG';

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }
  function corrupt(detail) {
    return fail(E_CORRUPT, 'This 7z archive is damaged and cannot be read (' + detail + '). ' +
      'Ask the supplier to resend it, or check it with 7-Zip.');
  }

  // ------------------------------------------------------------------------
  // CRC32 (IEEE 802.3, the one 7z uses), slicing-by-8 for speed: eight
  // 256-entry tables let the loop fold eight input bytes per step. T[k*256+n]
  // is the CRC of byte n followed by k zero bytes.
  // ------------------------------------------------------------------------
  var CRC_T = (function () {
    var t = new Int32Array(8 * 256), n, k, c;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    for (n = 0; n < 256; n++) {
      c = t[n];
      for (k = 1; k < 8; k++) {
        c = t[c & 0xFF] ^ (c >>> 8);
        t[k * 256 + n] = c;
      }
    }
    return t;
  })();

  // Running form: start with crc = -1 (all ones), feed buffers, and finish
  // with crc32Final(). Keeping the register inverted between calls is the
  // standard trick that makes incremental updates free.
  function crc32Update(crc, buf, start, end) {
    var t = CRC_T, i = start, a = 0, b = 0;
    crc |= 0;
    for (; i + 8 <= end; i += 8) {
      a = crc ^ (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24));
      b = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
      crc = t[1792 + (a & 0xFF)] ^ t[1536 + ((a >>> 8) & 0xFF)] ^
            t[1280 + ((a >>> 16) & 0xFF)] ^ t[1024 + (a >>> 24)] ^
            t[768 + (b & 0xFF)] ^ t[512 + ((b >>> 8) & 0xFF)] ^
            t[256 + ((b >>> 16) & 0xFF)] ^ t[b >>> 24];
    }
    for (; i < end; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
  }
  function crc32Final(crc) { return (crc ^ -1) >>> 0; }
  function crc32(buf) { return crc32Final(crc32Update(-1, buf, 0, buf.length)); }

  function hex8(n) { return ('0000000' + (n >>> 0).toString(16).toUpperCase()).slice(-8); }

  // Little-endian readers on a Uint8Array.
  function u32le(u8, p) {
    return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
  }
  // REAL_UINT64 in the signature header. JS numbers are exact to 2^53, far
  // beyond any archive a browser can hold, so anything larger is treated as
  // damage rather than silently rounded.
  function u64le(u8, p) {
    var lo = u32le(u8, p), hi = u32le(u8, p + 4);
    if (hi >= 0x200000) throw corrupt('a 64-bit size field is out of range');
    return hi * 4294967296 + lo;
  }

  // Accept a Uint8Array, a Node Buffer, an ArrayBuffer or any typed-array
  // view. Always return a plain Uint8Array view over the same memory, so the
  // decoder's hot loop only ever sees one array type (keeps it monomorphic).
  // The checks avoid instanceof so buffers from another realm (an iframe, a
  // worker message, Node's vm) are accepted too.
  function toU8(input) {
    if (input && typeof input === 'object') {
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      var tag = Object.prototype.toString.call(input);
      if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(input);
    }
    throw new TypeError('SevenZip: expected a Uint8Array or ArrayBuffer holding the .7z file');
  }

  var EMPTY = new Uint8Array(0);

  // ------------------------------------------------------------------------
  // Header reader
  //
  // 7z headers are a tree of "properties", each introduced by an ID byte.
  // Integers use the 7z NUMBER encoding: the number of leading 1 bits in the
  // first byte says how many extra bytes follow (0..8, little-endian), and
  // the first byte's remaining low bits are the most significant part.
  //   0xxxxxxx                    -> 0..127
  //   10xxxxxx b1                 -> up to 2^14 - 1
  //   110xxxxx b1 b2              -> up to 2^21 - 1   ... and so on
  //   11111111 b1..b8             -> full 64 bits
  // ------------------------------------------------------------------------
  var NID = {
    kEnd: 0x00, kHeader: 0x01, kArchiveProperties: 0x02, kAdditionalStreamsInfo: 0x03,
    kMainStreamsInfo: 0x04, kFilesInfo: 0x05, kPackInfo: 0x06, kUnpackInfo: 0x07,
    kSubStreamsInfo: 0x08, kSize: 0x09, kCRC: 0x0A, kFolder: 0x0B, kCodersUnpackSize: 0x0C,
    kNumUnpackStream: 0x0D, kEmptyStream: 0x0E, kEmptyFile: 0x0F, kAnti: 0x10, kName: 0x11,
    kCTime: 0x12, kATime: 0x13, kMTime: 0x14, kWinAttributes: 0x15, kComment: 0x16,
    kEncodedHeader: 0x17, kStartPos: 0x18, kDummy: 0x19
  };

  // Upper bounds that stop a damaged header from making us allocate absurd
  // arrays. Real archives are nowhere near them.
  var MAX_ITEMS = 1 << 22;          // files, folders or streams in one archive
  var MAX_HEADER_BYTES = 1 << 28;   // 256 MB of decoded header

  function Reader(u8, pos, end) {
    this.u8 = u8;
    this.pos = pos;
    this.end = end;
  }
  Reader.prototype.byte = function () {
    if (this.pos >= this.end) throw corrupt('the header ends unexpectedly');
    return this.u8[this.pos++];
  };
  Reader.prototype.number = function () {
    var first = this.byte(), mask = 0x80, value = 0, mul = 1, i;
    for (i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * mul;
        break;
      }
      value += this.byte() * mul;
      mul *= 256;
      mask >>>= 1;
    }
    if (value > 9007199254740991) throw corrupt('a header number is out of range');
    return value;
  };
  Reader.prototype.count = function () {
    var n = this.number();
    if (n > MAX_ITEMS) throw corrupt('an item count is implausibly large (' + n + ')');
    return n;
  };
  Reader.prototype.uint32 = function () {
    if (this.pos + 4 > this.end) throw corrupt('the header ends unexpectedly');
    var v = u32le(this.u8, this.pos);
    this.pos += 4;
    return v;
  };
  Reader.prototype.skip = function (n) {
    if (n > this.end - this.pos) throw corrupt('a header field runs past the end of the header');
    this.pos += n;
  };
  Reader.prototype.bytes = function (n) {
    if (n > this.end - this.pos) throw corrupt('a header field runs past the end of the header');
    var out = this.u8.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };
  // Bit vectors are packed most significant bit first.
  Reader.prototype.bits = function (n) {
    var out = new Array(n), b = 0, mask = 0, i;
    for (i = 0; i < n; i++) {
      if (mask === 0) { b = this.byte(); mask = 0x80; }
      out[i] = (b & mask) !== 0;
      mask >>>= 1;
    }
    return out;
  };
  // "AllAreDefined" byte, then (only if it is 0) a bit vector of which items
  // are defined.
  Reader.prototype.definedBits = function (n) {
    if (this.byte() !== 0) {
      var all = new Array(n), i;
      for (i = 0; i < n; i++) all[i] = true;
      return all;
    }
    return this.bits(n);
  };
  // A digest list: defined-bits, then one UINT32 CRC per defined item.
  // Items without a CRC come back as null.
  Reader.prototype.digests = function (n) {
    var defined = this.definedBits(n), out = new Array(n), i;
    for (i = 0; i < n; i++) out[i] = defined[i] ? this.uint32() : null;
    return out;
  };
  // Skip a property we do not use: its size (a NUMBER) then that many bytes.
  Reader.prototype.skipData = function () { this.skip(this.number()); };
  // Skip properties until the wanted ID (7-Zip's WaitId).
  Reader.prototype.waitId = function (id, what) {
    for (;;) {
      var t = this.number();
      if (t === id) return;
      if (t === NID.kEnd) throw corrupt(what + ' is missing');
      this.skipData();
    }
  };

  function readPackInfo(r) {
    var packPos = r.number(), n = r.count(), sizes = new Array(n), crcs = null, i, t;
    r.waitId(NID.kSize, 'the packed stream size list');
    for (i = 0; i < n; i++) sizes[i] = r.number();
    for (;;) {
      t = r.number();
      if (t === NID.kEnd) break;
      if (t === NID.kCRC) { crcs = r.digests(n); continue; }
      r.skipData();
    }
    return { packPos: packPos, sizes: sizes, crcs: crcs };
  }

  // A folder is a small graph of coders. Each coder has "in" streams (the
  // packed side, read by the decoder) and "out" streams (the unpacked side).
  // Bind pairs connect one coder's out stream to another coder's in stream;
  // the in streams left unbound are the folder's packed streams, and the one
  // out stream left unbound is the folder's final output.
  function readFolder(r) {
    var numCoders = r.number(), coders = [], numIn = 0, numOut = 0, i, j;
    if (numCoders < 1 || numCoders > 64) throw corrupt('a folder has ' + numCoders + ' coders');
    for (i = 0; i < numCoders; i++) {
      var main = r.byte();
      // Bit 7 ("alternative methods") was dropped from the format long ago
      // and bit 6 is reserved; 7-Zip itself refuses both.
      if (main & 0xC0) throw fail(E_UNSUPPORTED, 'This 7z archive uses a coder layout this reader does not support (reserved coder flags are set).');
      var idSize = main & 0x0F;
      if (idSize > 8) throw corrupt('a coder id is ' + idSize + ' bytes long');
      var idBytes = r.bytes(idSize), id = '';
      for (j = 0; j < idSize; j++) id += (idBytes[j] < 16 ? '0' : '') + idBytes[j].toString(16);
      var nIn = 1, nOut = 1;
      if (main & 0x10) {
        nIn = r.number();
        nOut = r.number();
        if (nIn < 1 || nIn > 64 || nOut < 1 || nOut > 64) throw corrupt('a coder has an invalid stream count');
      }
      var props = null;
      if (main & 0x20) props = r.bytes(r.number());
      coders.push({ id: id, numIn: nIn, numOut: nOut, props: props });
      numIn += nIn;
      numOut += nOut;
    }
    var bindPairs = [];
    for (i = 0; i < numOut - 1; i++) {
      var inIndex = r.number(), outIndex = r.number();
      if (inIndex >= numIn || outIndex >= numOut) throw corrupt('a coder bind pair is out of range');
      bindPairs.push({ inIndex: inIndex, outIndex: outIndex });
    }
    var numPacked = numIn - bindPairs.length, packedStreams = [];
    if (numPacked < 1) throw corrupt('a folder has no packed stream');
    if (numPacked === 1) {
      for (i = 0; i < numIn; i++) {
        if (!bindPairs.some(function (bp) { return bp.inIndex === i; })) { packedStreams.push(i); break; }
      }
      if (packedStreams.length !== 1) throw corrupt('a folder has no unbound input');
    } else {
      for (i = 0; i < numPacked; i++) packedStreams.push(r.number());
    }
    return {
      coders: coders, numInTotal: numIn, numOutTotal: numOut, bindPairs: bindPairs,
      packedStreams: packedStreams, unpackSizes: [], unpackSize: 0, crc: null,
      firstPackStream: 0, packOffset: 0, packSize: 0
    };
  }

  function readUnpackInfo(r) {
    var n, folders = [], i, j, t;
    r.waitId(NID.kFolder, 'the folder list');
    n = r.count();
    if (r.byte() !== 0) {
      throw fail(E_UNSUPPORTED, 'This 7z archive stores its folder table in a separate stream, which this reader does not support.');
    }
    for (i = 0; i < n; i++) folders.push(readFolder(r));
    r.waitId(NID.kCodersUnpackSize, 'the unpacked size list');
    for (i = 0; i < n; i++) {
      var f = folders[i], mainOut = -1;
      for (j = 0; j < f.numOutTotal; j++) f.unpackSizes.push(r.number());
      for (j = 0; j < f.numOutTotal && mainOut < 0; j++) {
        var bound = false, k;
        for (k = 0; k < f.bindPairs.length; k++) if (f.bindPairs[k].outIndex === j) bound = true;
        if (!bound) mainOut = j;
      }
      if (mainOut < 0) throw corrupt('a folder has no final output');
      f.unpackSize = f.unpackSizes[mainOut];
    }
    for (;;) {
      t = r.number();
      if (t === NID.kEnd) break;
      if (t === NID.kCRC) {
        var d = r.digests(n);
        for (i = 0; i < n; i++) folders[i].crc = d[i];
        continue;
      }
      r.skipData();
    }
    return folders;
  }

  // SubStreamsInfo splits each folder's output into the files it holds
  // (a solid folder holds many). Sizes are listed for all but the last file
  // of a folder, whose size is what remains. CRCs are listed only for streams
  // whose CRC is not already known: a folder holding exactly one file with a
  // folder CRC reuses that CRC.
  function readSubStreamsInfo(r, folders) {
    var nf = folders.length, counts = [], sizes = [], crcs = [], i, j, t, k;
    for (i = 0; i < nf; i++) counts.push(1);
    for (;;) {
      t = r.number();
      if (t === NID.kNumUnpackStream) {
        for (i = 0; i < nf; i++) counts[i] = r.count();
        continue;
      }
      if (t === NID.kCRC || t === NID.kSize || t === NID.kEnd) break;
      r.skipData();
    }
    for (i = 0; i < nf; i++) {
      var c = counts[i], sum = 0;
      if (c === 0) continue;
      if (c > 1 && t !== NID.kSize) throw corrupt('file sizes inside a solid block are missing');
      for (j = 1; j < c; j++) {
        var s = r.number();
        sizes.push(s);
        sum += s;
      }
      if (sum > folders[i].unpackSize) throw corrupt('file sizes add up to more than their block');
      sizes.push(folders[i].unpackSize - sum);
    }
    if (t === NID.kSize) t = r.number();
    var numDigests = 0;
    for (i = 0; i < nf; i++) {
      if (counts[i] !== 1 || folders[i].crc === null) numDigests += counts[i];
    }
    var listed = null;
    for (;;) {
      if (t === NID.kEnd) break;
      if (t === NID.kCRC) listed = r.digests(numDigests);
      else r.skipData();
      t = r.number();
    }
    k = 0;
    for (i = 0; i < nf; i++) {
      if (counts[i] === 1 && folders[i].crc !== null) { crcs.push(folders[i].crc); continue; }
      for (j = 0; j < counts[i]; j++) crcs.push(listed ? listed[k++] : null);
    }
    return { counts: counts, sizes: sizes, crcs: crcs };
  }

  function readStreamsInfo(r) {
    var si = { pack: { packPos: 0, sizes: [], crcs: null }, folders: [], sub: null };
    var t = r.number();
    if (t === NID.kPackInfo) { si.pack = readPackInfo(r); t = r.number(); }
    if (t === NID.kUnpackInfo) { si.folders = readUnpackInfo(r); t = r.number(); }
    if (t === NID.kSubStreamsInfo) { si.sub = readSubStreamsInfo(r, si.folders); t = r.number(); }
    if (t !== NID.kEnd) throw corrupt('unexpected field ' + t + ' in the stream table');
    if (!si.sub) {
      // No SubStreamsInfo: every folder holds exactly one stream.
      si.sub = { counts: [], sizes: [], crcs: [] };
      si.folders.forEach(function (f) {
        si.sub.counts.push(1);
        si.sub.sizes.push(f.unpackSize);
        si.sub.crcs.push(f.crc);
      });
    }
    return si;
  }

  // Names are UTF-16LE, each terminated by a 0 code unit. Surrogate pairs
  // need no special handling: JS strings are UTF-16 already.
  function readNames(r, n) {
    var names = new Array(n), u8 = r.u8, i, units, c;
    for (i = 0; i < n; i++) {
      units = [];
      for (;;) {
        if (r.pos + 2 > r.end) throw corrupt('the file name table is cut short');
        c = u8[r.pos] | (u8[r.pos + 1] << 8);
        r.pos += 2;
        if (c === 0) break;
        units.push(c);
      }
      var s = '', p;
      for (p = 0; p < units.length; p += 4096) s += String.fromCharCode.apply(null, units.slice(p, p + 4096));
      // Some Windows tools store '\' as the path separator; report '/' like
      // py7zr and 7-Zip do.
      names[i] = s.replace(/\\/g, '/');
    }
    return names;
  }

  function readFilesInfo(r) {
    var n = r.count(), names = null, emptyStream = null, emptyFile = null, anti = null;
    var numEmpty = 0, i, t, size, end, sub, propIds = [];
    for (;;) {
      t = r.number();
      if (t === NID.kEnd) break;
      if (propIds.indexOf(t) < 0) propIds.push(t);
      size = r.number();
      if (size > r.end - r.pos) throw corrupt('a file property runs past the end of the header');
      end = r.pos + size;
      // Each property is parsed with a reader fenced to its declared size,
      // and parsing always resumes at that size. That is also how unknown
      // properties, timestamps, attributes and kDummy padding are skipped.
      sub = new Reader(r.u8, r.pos, end);
      switch (t) {
        case NID.kName:
          if (sub.byte() !== 0) {
            throw fail(E_UNSUPPORTED, 'This 7z archive stores its file names in a separate stream, which this reader does not support.');
          }
          names = readNames(sub, n);
          break;
        case NID.kEmptyStream:
          emptyStream = sub.bits(n);
          numEmpty = 0;
          for (i = 0; i < n; i++) if (emptyStream[i]) numEmpty++;
          break;
        case NID.kEmptyFile:
          emptyFile = sub.bits(numEmpty);
          break;
        case NID.kAnti:
          anti = sub.bits(numEmpty);
          break;
        default:
          // kCTime/kATime/kMTime, kWinAttributes, kStartPos, kComment,
          // kDummy and anything newer: not needed to extract.
          break;
      }
      r.pos = end;
    }
    var files = [], e = 0;
    for (i = 0; i < n; i++) {
      var f = {
        name: names ? names[i] : '', hasStream: true, isDir: false, isAnti: false,
        size: 0, crc: null, folderIndex: null, subIndex: -1
      };
      if (emptyStream && emptyStream[i]) {
        // 7-Zip's rule: an entry with no data stream is a directory unless
        // the kEmptyFile bit marks it as an empty file.
        f.hasStream = false;
        f.isDir = !(emptyFile && emptyFile[e]);
        f.isAnti = !!(anti && anti[e]);
        e++;
      }
      files.push(f);
    }
    return { files: files, propIds: propIds };
  }

  function readHeader(r) {
    var t = r.number(), main = null, files = [], propIds = [];
    if (t === NID.kArchiveProperties) {
      for (;;) { if (r.number() === NID.kEnd) break; r.skipData(); }
      t = r.number();
    }
    if (t === NID.kAdditionalStreamsInfo) {
      // Only used for "external" names/attributes, which are refused above.
      readStreamsInfo(r);
      t = r.number();
    }
    if (t === NID.kMainStreamsInfo) { main = readStreamsInfo(r); t = r.number(); }
    if (t === NID.kFilesInfo) {
      var fi = readFilesInfo(r);
      files = fi.files;
      propIds = fi.propIds;
      t = r.number();
    }
    if (t !== NID.kEnd) throw corrupt('unexpected field ' + t + ' at the end of the header');
    return { main: main, files: files, propIds: propIds };
  }

  // Work out where each folder's packed bytes sit in the file. Pack streams
  // are stored back to back starting at 32 (end of the signature header) +
  // packPos, and folders consume them in order.
  function locatePackStreams(si, fileLength, limit) {
    var offset = 32 + si.pack.packPos, offsets = [], i;
    for (i = 0; i < si.pack.sizes.length; i++) {
      offsets.push(offset);
      offset += si.pack.sizes[i];
    }
    if (offset > fileLength) throw truncatedError(offset, fileLength);
    if (offset > limit) throw corrupt('the packed data overlaps the header');
    var next = 0;
    si.folders.forEach(function (f) {
      f.firstPackStream = next;
      next += f.packedStreams.length;
      if (next > offsets.length) throw corrupt('a folder refers to a packed stream that does not exist');
      f.packOffset = offsets[f.firstPackStream];
      f.packSize = si.pack.sizes[f.firstPackStream];
    });
  }

  function truncatedError(needed, have) {
    return fail(E_TRUNCATED, 'This 7z file is incomplete: it needs ' + needed + ' bytes but only ' + have +
      ' are present. Either the download or email attachment was cut short, or this is one part of a ' +
      'split archive (.7z.001, .7z.002, ...). Save the complete file (or join all the parts) and try again.');
  }

  // ------------------------------------------------------------------------
  // LZMA decoder
  //
  // LZMA is LZ77 (literals plus back-references into a sliding dictionary)
  // whose every decision bit is coded by an adaptive binary range coder.
  // Each "probability" is an 11-bit estimate (0..2048) that a bit is 0, moved
  // towards the bit actually seen by 1/32 of the gap after each use.
  //
  // All probabilities live in one Uint16Array; the offsets below follow the
  // LZMA SDK's layout. "state" (0..11) remembers the last few packet kinds
  // (literal, match, rep, short rep); states 0..6 mean "last packet was a
  // literal". posState is the low pb bits of the output position.
  // ------------------------------------------------------------------------
  var P_IS_MATCH = 0;        // [state << 4 | posState]       192
  var P_IS_REP = 192;        // [state]                         12
  var P_IS_REP_G0 = 204;     // [state]                         12
  var P_IS_REP_G1 = 216;     // [state]                         12
  var P_IS_REP_G2 = 228;     // [state]                         12
  var P_IS_REP0_LONG = 240;  // [state << 4 | posState]       192
  var P_POS_SLOT = 432;      // [lenState << 6 | 6-bit tree]   256
  var P_SPEC_POS = 688;      // reverse trees for slots 4..13  114
  var P_ALIGN = 802;         // 4-bit reverse tree              16
  var P_LEN = 818;           // length coder for new matches   514
  var P_REP_LEN = 1332;      // length coder for rep matches   514
  var P_LITERAL = 1846;      // 0x300 per literal context
  // Inside a length coder: +0 choice, +1 choice2, +2 low[16][8],
  // +130 mid[16][8], +258 high[256]. Lengths are 2 + (0..7 | 8..15 | 16..271).

  // The dictionary is a circular buffer. It never needs to be larger than
  // the whole output, so a 64 MB dictionary on a 1 MB file costs 1 MB.
  function LzmaDecoder(dictSize, outSize) {
    // The LZMA SDK treats anything below 4 KB as 4 KB.
    this.dictSize = Math.max(dictSize, 4096);
    var bufSize = Math.max(1, Math.min(this.dictSize, outSize));
    try {
      this.dic = new Uint8Array(bufSize);
    } catch (err) {
      throw fail(E_TOO_BIG, 'This 7z archive needs a ' + Math.round(bufSize / 1048576) +
        ' MB decompression buffer, which this browser could not allocate. Extract it with 7-Zip instead.');
    }
    this.bufSize = bufSize;
    this.dicPos = 0;          // write position in dic
    this.processedPos = 0;    // bytes written since the last dictionary reset
    this.probs = null;
    this.lc = 0; this.lpMask = 0; this.pbMask = 0;
    this.state = 0;
    this.rep0 = 0; this.rep1 = 0; this.rep2 = 0; this.rep3 = 0;   // distances minus 1
    this.remainLen = 0;       // bytes of a match still to copy after a limit cut it short
    this.finished = false;    // end-of-stream marker seen
    this.inBuf = EMPTY; this.inPos = 0; this.inEnd = 0;
    this.range = 0; this.code = 0;
  }

  // lc: literal context bits (high bits of the previous byte); lp: literal
  // position bits; pb: position bits for posState.
  LzmaDecoder.prototype.setProps = function (lc, lp, pb, reserveLcLp) {
    var need = P_LITERAL + (0x300 << Math.max(lc + lp, reserveLcLp || 0));
    if (!this.probs || this.probs.length < need) this.probs = new Uint16Array(need);
    this.lc = lc;
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
    this.numProbs = P_LITERAL + (0x300 << (lc + lp));
  };

  LzmaDecoder.prototype.resetState = function () {
    this.probs.fill(1024, 0, this.numProbs);   // 1024 = probability one half
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.remainLen = 0;
  };

  // The range coder starts with 5 bytes: a zero byte (the encoder's initial
  // cache) and the 32-bit big-endian code value.
  LzmaDecoder.prototype.initRange = function (buf, pos, end) {
    if (end - pos < 5) throw corrupt('a compressed stream is shorter than its 5-byte start');
    if (buf[pos] !== 0) throw corrupt('a compressed stream does not start with the LZMA marker byte');
    this.inBuf = buf;
    this.inEnd = end;
    this.code = (buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4];
    this.range = -1;          // 0xFFFFFFFF held as int32
    this.inPos = pos + 5;
  };

  // Decode until dicPos reaches limit (limit <= bufSize), or the end marker.
  //
  // Speed matters (hundreds of MB per pricebook), so the range coder is
  // written out inline at every decision instead of calling a helper, and
  // the hot state lives in local variables. To stay on int32 arithmetic,
  // range and code are kept as int32 bit patterns of the unsigned values:
  //   - bound = (range >>> 11) * prob fits in 32 bits, Math.imul gives it;
  //   - an unsigned compare a < b is (a ^ 0x80000000) < (b ^ 0x80000000);
  //   - "range < 2^24" is (range & 0xFF000000) === 0.
  // The repeated block reads: normalise (shift in a byte when the range gets
  // small), split the range at bound, then take the 0 branch (code < bound)
  // or the 1 branch, adapting the probability towards what was seen.
  //
  // Reading past the end of inBuf yields undefined, which bitwise operators
  // treat as 0, so a truncated stream decodes garbage instead of crashing;
  // the caller detects it from inPos and the CRC.
  LzmaDecoder.prototype.decodeTo = function (limit) {
    var dic = this.dic, bufSize = this.bufSize, dicPos = this.dicPos;
    var probs = this.probs, inBuf = this.inBuf, inPos = this.inPos;
    var range = this.range | 0, code = this.code | 0;
    var state = this.state, rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    var processedPos = this.processedPos, dictSize = this.dictSize, remainLen = this.remainLen;
    var lc = this.lc, lpMask = this.lpMask, pbMask = this.pbMask;
    var prob = 0, bound = 0, i = 0, j = 0, sym = 0, posState = 0, len = 0, src = 0;
    var n = 0, dist = 0, matchByte = 0, offs = 0, bit = 0, isRep = false, lenBase = 0, treeTop = 0;

    // A match that the previous call had to cut short at its limit.
    if (remainLen > 0 && dicPos < limit) {
      n = limit - dicPos;
      len = remainLen < n ? remainLen : n;
      remainLen -= len;
      processedPos += len;
      src = dicPos - rep0 - 1;
      if (src < 0) src += bufSize;
      do {
        dic[dicPos++] = dic[src++];
        if (src === bufSize) src = 0;
      } while (--len !== 0);
    }

    while (dicPos < limit) {
      posState = processedPos & pbMask;

      // ---- is this packet a literal (0) or a match (1)? ----
      i = P_IS_MATCH + (state << 4) + posState;
      prob = probs[i];
      if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
      bound = Math.imul(range >>> 11, prob);
      if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
        range = bound; probs[i] = prob + ((2048 - prob) >>> 5);

        // ---- literal: 8 bits through a binary tree chosen by context ----
        i = P_LITERAL;
        if (processedPos > 0) {
          sym = dic[(dicPos === 0 ? bufSize : dicPos) - 1];   // previous byte
          i += 0x300 * (((processedPos & lpMask) << lc) + (sym >>> (8 - lc)));
        }
        sym = 1;
        if (state < 7) {
          do {
            j = i + sym;
            prob = probs[j];
            if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
            bound = Math.imul(range >>> 11, prob);
            if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
              range = bound; probs[j] = prob + ((2048 - prob) >>> 5); sym <<= 1;
            } else {
              range = (range - bound) | 0; code = (code - bound) | 0; probs[j] = prob - (prob >>> 5); sym = (sym << 1) | 1;
            }
          } while (sym < 0x100);
        } else {
          // "Matched" literal right after a match: the byte at rep0 is used
          // as extra context for as long as the decoded bits agree with it
          // (offs = 0x100); after the first disagreement offs drops to 0 and
          // the plain tree is used for the remaining bits.
          src = dicPos - rep0 - 1;
          if (src < 0) src += bufSize;
          matchByte = dic[src];
          offs = 0x100;
          do {
            matchByte <<= 1;
            bit = matchByte & offs;
            j = i + offs + bit + sym;
            prob = probs[j];
            if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
            bound = Math.imul(range >>> 11, prob);
            if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
              range = bound; probs[j] = prob + ((2048 - prob) >>> 5); sym <<= 1; offs &= ~bit;
            } else {
              range = (range - bound) | 0; code = (code - bound) | 0; probs[j] = prob - (prob >>> 5); sym = (sym << 1) | 1; offs &= bit;
            }
          } while (sym < 0x100);
        }
        dic[dicPos++] = sym;          // Uint8Array keeps the low 8 bits
        processedPos++;
        state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
        continue;
      }
      range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);

      // ---- match: new distance (0) or one of the four recent ones (1)? ----
      i = P_IS_REP + state;
      prob = probs[i];
      if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
      bound = Math.imul(range >>> 11, prob);
      if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
        range = bound; probs[i] = prob + ((2048 - prob) >>> 5);
        isRep = false;
        lenBase = P_LEN;
      } else {
        range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);
        if (processedPos === 0) throw corrupt('LZMA data repeats bytes before any were written');
        isRep = true;
        lenBase = P_REP_LEN;

        i = P_IS_REP_G0 + state;
        prob = probs[i];
        if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
        bound = Math.imul(range >>> 11, prob);
        if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
          range = bound; probs[i] = prob + ((2048 - prob) >>> 5);
          // rep0: a single byte ("short rep", 0) or a run with a length (1)
          i = P_IS_REP0_LONG + (state << 4) + posState;
          prob = probs[i];
          if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
          bound = Math.imul(range >>> 11, prob);
          if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
            range = bound; probs[i] = prob + ((2048 - prob) >>> 5);
            state = state < 7 ? 9 : 11;
            src = dicPos - rep0 - 1;
            if (src < 0) src += bufSize;
            dic[dicPos++] = dic[src];
            processedPos++;
            continue;
          }
          range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);
        } else {
          range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);
          i = P_IS_REP_G1 + state;
          prob = probs[i];
          if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
          bound = Math.imul(range >>> 11, prob);
          if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
            range = bound; probs[i] = prob + ((2048 - prob) >>> 5);
            dist = rep1;
          } else {
            range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);
            i = P_IS_REP_G2 + state;
            prob = probs[i];
            if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
            bound = Math.imul(range >>> 11, prob);
            if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
              range = bound; probs[i] = prob + ((2048 - prob) >>> 5);
              dist = rep2;
            } else {
              range = (range - bound) | 0; code = (code - bound) | 0; probs[i] = prob - (prob >>> 5);
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
      }

      // ---- length: choice bits pick the low/mid/high tree ----
      prob = probs[lenBase];
      if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
      bound = Math.imul(range >>> 11, prob);
      if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
        range = bound; probs[lenBase] = prob + ((2048 - prob) >>> 5);
        i = lenBase + 2 + (posState << 3); treeTop = 8; len = 0;
      } else {
        range = (range - bound) | 0; code = (code - bound) | 0; probs[lenBase] = prob - (prob >>> 5);
        prob = probs[lenBase + 1];
        if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
        bound = Math.imul(range >>> 11, prob);
        if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
          range = bound; probs[lenBase + 1] = prob + ((2048 - prob) >>> 5);
          i = lenBase + 130 + (posState << 3); treeTop = 8; len = 8;
        } else {
          range = (range - bound) | 0; code = (code - bound) | 0; probs[lenBase + 1] = prob - (prob >>> 5);
          i = lenBase + 258; treeTop = 256; len = 16;
        }
      }
      sym = 1;
      do {
        j = i + sym;
        prob = probs[j];
        if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
        bound = Math.imul(range >>> 11, prob);
        if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
          range = bound; probs[j] = prob + ((2048 - prob) >>> 5); sym <<= 1;
        } else {
          range = (range - bound) | 0; code = (code - bound) | 0; probs[j] = prob - (prob >>> 5); sym = (sym << 1) | 1;
        }
      } while (sym < treeTop);
      len += sym - treeTop;           // 0-based: the real length is len + 2

      if (isRep) {
        state = state < 7 ? 8 : 11;
      } else {
        // ---- distance of a new match ----
        // A 6-bit "slot" (tree chosen by length, capped at 3) gives the top
        // two bits and the bit count. Slots 4..13 code the remaining bits
        // with reverse trees; larger slots send the middle bits raw
        // ("direct bits", half the range each) and the low 4 bits through
        // the align reverse tree.
        i = P_POS_SLOT + ((len < 4 ? len : 3) << 6);
        sym = 1;
        do {
          j = i + sym;
          prob = probs[j];
          if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
          bound = Math.imul(range >>> 11, prob);
          if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
            range = bound; probs[j] = prob + ((2048 - prob) >>> 5); sym <<= 1;
          } else {
            range = (range - bound) | 0; code = (code - bound) | 0; probs[j] = prob - (prob >>> 5); sym = (sym << 1) | 1;
          }
        } while (sym < 64);
        sym -= 64;                      // the slot
        if (sym < 4) {
          dist = sym;
        } else {
          n = (sym >>> 1) - 1;          // bits below the top two
          dist = 2 | (sym & 1);
          if (sym < 14) {
            dist <<= n;
            i = P_SPEC_POS + dist - sym - 1;
            j = 1;                       // tree index
            offs = 1;                    // value of the bit being decoded
            do {
              prob = probs[i + j];
              if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
              bound = Math.imul(range >>> 11, prob);
              if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
                range = bound; probs[i + j] = prob + ((2048 - prob) >>> 5); j <<= 1;
              } else {
                range = (range - bound) | 0; code = (code - bound) | 0; probs[i + j] = prob - (prob >>> 5); j = (j << 1) | 1; dist |= offs;
              }
              offs <<= 1;
            } while (--n !== 0);
          } else {
            n -= 4;
            do {
              if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
              range = range >>> 1;
              code = (code - range) | 0;
              bit = code >> 31;              // -1 if code was below range (bit 0), else 0
              dist = (dist << 1) + (bit + 1);
              code = (code + (range & bit)) | 0;
            } while (--n !== 0);
            // Up to 28 bits so far; the shift by 4 below may pass 2^31, so
            // it is done in floating point.
            j = 1;
            offs = 0;
            for (n = 0; n < 4; n++) {
              prob = probs[P_ALIGN + j];
              if ((range & 0xFF000000) === 0) { range <<= 8; code = (code << 8) | inBuf[inPos++]; }
              bound = Math.imul(range >>> 11, prob);
              if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
                range = bound; probs[P_ALIGN + j] = prob + ((2048 - prob) >>> 5); j <<= 1;
              } else {
                range = (range - bound) | 0; code = (code - bound) | 0; probs[P_ALIGN + j] = prob - (prob >>> 5); j = (j << 1) | 1; offs |= 1 << n;
              }
            }
            dist = dist * 16 + offs;
            if (dist === 4294967295) {
              // End-of-stream marker (distance 0xFFFFFFFF).
              this.finished = true;
              break;
            }
          }
        }
        rep3 = rep2; rep2 = rep1; rep1 = rep0; rep0 = dist;
        state = state < 7 ? 7 : 10;
      }

      // A distance must point inside the data written so far (and inside
      // the dictionary). Anything else means the stream is damaged.
      if (rep0 >= (processedPos < dictSize ? processedPos : dictSize)) {
        throw corrupt('LZMA data refers back ' + (rep0 + 1) + ' bytes but only ' +
          Math.min(processedPos, dictSize) + ' are available');
      }

      // ---- copy len + 2 bytes from rep0 + 1 bytes back ----
      len += 2;
      n = limit - dicPos;
      if (len > n) { remainLen = len - n; len = n; }
      processedPos += len;
      src = dicPos - rep0 - 1;
      if (src < 0) src += bufSize;
      if (src + len <= bufSize) {
        // The source does not wrap. Long copies whose source and target do
        // not overlap go through copyWithin (a native memmove); overlapping
        // ones (distance shorter than length, i.e. a repeating pattern) must
        // be copied forwards byte by byte.
        if (len > 64 && (src > dicPos || src + len <= dicPos)) {
          dic.copyWithin(dicPos, src, src + len);
          dicPos += len;
        } else {
          do { dic[dicPos++] = dic[src++]; } while (--len !== 0);
        }
      } else {
        do {
          dic[dicPos++] = dic[src++];
          if (src === bufSize) src = 0;
        } while (--len !== 0);
      }
    }

    this.dicPos = dicPos;
    this.inPos = inPos;
    this.range = range;
    this.code = code;
    this.state = state;
    this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
    this.processedPos = processedPos;
    this.remainLen = remainLen;
  };

  // One last normalisation, as the LZMA SDK does after its loop: at the end
  // of an LZMA2 chunk this consumes the final byte the encoder flushed, so
  // the input position lands exactly on the chunk boundary.
  LzmaDecoder.prototype.normalize = function () {
    if ((this.range & 0xFF000000) === 0) {
      this.range <<= 8;
      this.code = (this.code << 8) | this.inBuf[this.inPos++];
    }
  };

  // ------------------------------------------------------------------------
  // Folder streams. Each has read(max) returning a Uint8Array view of the
  // next 1..max output bytes (valid until the next call), or throwing.
  // Output for the LZMA kinds is a view into the dictionary window, so it
  // must be copied (or hashed) before the next read.
  // ------------------------------------------------------------------------

  // Copy (00): the packed bytes are the data.
  function CopyStream(input, outSize) {
    if (input.length < outSize) throw truncatedError(outSize, input.length);
    this.input = input;
    this.pos = 0;
    this.remaining = outSize;
  }
  CopyStream.prototype.read = function (max) {
    var n = Math.min(max, this.remaining), view = this.input.subarray(this.pos, this.pos + n);
    this.pos += n;
    this.remaining -= n;
    return view;
  };

  // LZMA (030101). Coder properties are 5 bytes: lc/lp/pb packed as
  // (pb * 5 + lp) * 9 + lc, then the dictionary size (UINT32 LE).
  // 7-Zip writes no end marker (the size is in the header); other encoders
  // (liblzma, so py7zr) do. Decoding stops at the known size either way, and
  // a marker that arrives early is reported as damage.
  function LzmaStream(props, input, outSize) {
    if (!props || props.length < 5) throw corrupt('LZMA coder properties are missing');
    var d = props[0];
    if (d >= 9 * 5 * 5) throw corrupt('LZMA coder properties are invalid');
    var lc = d % 9, lp = Math.floor(d / 9) % 5, pb = Math.floor(d / 45);
    var lz = new LzmaDecoder(u32le(props, 1), outSize);
    lz.setProps(lc, lp, pb, 0);
    lz.resetState();
    this.lz = lz;
    this.remaining = outSize;
    this.inputLength = input.length;
    if (outSize > 0) lz.initRange(input, 0, input.length);
  }
  LzmaStream.prototype.read = function (max) {
    var lz = this.lz;
    if (lz.dicPos === lz.bufSize) lz.dicPos = 0;   // wrap the window
    var start = lz.dicPos, n = Math.min(max, this.remaining, lz.bufSize - start);
    if (n <= 0) return EMPTY;
    lz.decodeTo(start + n);
    // The range coder never reads beyond the bytes the encoder wrote, so
    // running past the packed size means the data is cut short or damaged.
    if (lz.inPos > this.inputLength) throw corrupt('the compressed data ends too early');
    var got = lz.dicPos - start;
    if (got < n) throw corrupt('the LZMA data ended ' + (this.remaining - got) + ' bytes before the size recorded in the header');
    this.remaining -= got;
    return lz.dic.subarray(start, lz.dicPos);
  };

  // LZMA2 (21). A sequence of chunks, each starting with a control byte:
  //   0x00            end of stream
  //   0x01            uncompressed chunk, dictionary reset
  //   0x02            uncompressed chunk, no reset
  //     then: 2 bytes big-endian (size - 1), then the raw bytes
  //   0x80..0xFF      LZMA chunk; bits 0-4 are bits 16-20 of (unpacked size - 1);
  //                   bits 5-6 say what to reset first:
  //                     0 nothing, 1 state, 2 state + new props, 3 everything incl. dictionary
  //     then: 2 bytes (unpacked size - 1, low 16 bits), 2 bytes (packed size - 1),
  //           1 props byte if bits 5-6 >= 2, then the packed bytes.
  // Every LZMA chunk restarts the range coder; the dictionary, and unless
  // reset the probabilities, carry over. Uncompressed chunks still go into the
  // dictionary because later chunks may copy from them. The one coder
  // property byte encodes the dictionary size: (2 | (b & 1)) << (b / 2 + 11).
  var LZMA2_NEED_DICT = 0xE0;   // first chunk must reset the dictionary
  var LZMA2_NEED_PROPS = 0xC0;  // after an uncompressed dictionary reset, next LZMA chunk must send props

  function Lzma2Stream(props, input, outSize) {
    if (!props || props.length < 1) throw corrupt('LZMA2 coder properties are missing');
    var b = props[0];
    if (b > 40) throw corrupt('LZMA2 dictionary size property is invalid');
    var dictSize = b === 40 ? 4294967295 : (2 | (b & 1)) * Math.pow(2, (b >>> 1) + 11);
    var lz = new LzmaDecoder(dictSize, outSize);
    lz.setProps(0, 0, 0, 4);      // LZMA2 allows lc + lp <= 4; reserve the maximum once
    this.lz = lz;
    this.input = input;
    this.pos = 0;
    this.remaining = outSize;
    this.chunkKind = 0;           // 0 = expect control byte, 1 = uncompressed, 2 = LZMA
    this.chunkLeft = 0;           // unpacked bytes left in the current chunk
    this.chunkEnd = 0;            // end of the current LZMA chunk's packed bytes
    this.needInit = LZMA2_NEED_DICT;
    this.ended = false;           // end-of-stream control byte (0x00) seen
  }

  Lzma2Stream.prototype.nextChunk = function () {
    var input = this.input, p = this.pos, lz = this.lz, c, size;
    if (p >= input.length) throw corrupt('the LZMA2 data ends without an end marker');
    c = input[p++];
    if (c === 0x00) { this.pos = p; this.ended = true; return false; }
    if (c === 0x01 || c === 0x02) {
      if (c === 0x02 && this.needInit === LZMA2_NEED_DICT) throw corrupt('the LZMA2 data does not start with a dictionary reset');
      if (p + 2 > input.length) throw corrupt('the LZMA2 data is cut short');
      size = ((input[p] << 8) | input[p + 1]) + 1;
      p += 2;
      if (p + size > input.length) throw corrupt('the LZMA2 data is cut short');
      if (c === 0x01) {
        lz.processedPos = 0;
        this.needInit = LZMA2_NEED_PROPS;
      }
      this.chunkKind = 1;
      this.chunkLeft = size;
      this.pos = p;
      return true;
    }
    if (c < 0x80) throw corrupt('the LZMA2 data has an invalid control byte 0x' + c.toString(16));
    if (c < this.needInit) throw corrupt('an LZMA2 chunk continues state that was never initialised');
    this.needInit = 0;
    if (p + 4 > input.length) throw corrupt('the LZMA2 data is cut short');
    size = (c & 0x1F) * 65536 + ((input[p] << 8) | input[p + 1]) + 1;
    var packSize = ((input[p + 2] << 8) | input[p + 3]) + 1, mode = (c >>> 5) & 3;
    p += 4;
    if (mode >= 2) {
      if (p >= input.length) throw corrupt('the LZMA2 data is cut short');
      var d = input[p++];
      if (d >= 9 * 5 * 5) throw corrupt('LZMA2 chunk properties are invalid');
      var lc = d % 9, lp = Math.floor(d / 9) % 5, pb = Math.floor(d / 45);
      if (lc + lp > 4) throw corrupt('LZMA2 chunk properties are invalid (lc + lp > 4)');
      lz.setProps(lc, lp, pb, 4);
    }
    if (mode === 3) lz.processedPos = 0;
    if (mode >= 1) lz.resetState();
    if (p + packSize > input.length) throw corrupt('the LZMA2 data is cut short');
    lz.initRange(input, p, p + packSize);
    this.chunkKind = 2;
    this.chunkLeft = size;
    this.chunkEnd = p + packSize;
    this.pos = p + packSize;
    return true;
  };

  Lzma2Stream.prototype.read = function (max) {
    var lz = this.lz;
    if (lz.dicPos === lz.bufSize) lz.dicPos = 0;
    var start = lz.dicPos, want = Math.min(max, this.remaining, lz.bufSize - start);
    if (want <= 0) return EMPTY;
    var limit = start + want, n, before;
    while (lz.dicPos < limit) {
      if (this.chunkKind === 0) {
        if (this.ended || !this.nextChunk()) break;
        continue;
      }
      n = Math.min(limit - lz.dicPos, this.chunkLeft);
      if (this.chunkKind === 1) {
        var from = this.pos;
        lz.dic.set(this.input.subarray(from, from + n), lz.dicPos);
        lz.dicPos += n;
        lz.processedPos += n;
        this.pos = from + n;
      } else {
        before = lz.dicPos;
        lz.decodeTo(before + n);
        if (lz.dicPos - before !== n || lz.inPos > this.chunkEnd) {
          throw corrupt('an LZMA2 chunk does not decode to its recorded size');
        }
      }
      this.chunkLeft -= n;
      if (this.chunkLeft === 0) {
        if (this.chunkKind === 2) {
          // The chunk must end exactly on its packed size, with no match
          // left hanging over and the range coder flushed to zero, as the
          // LZMA SDK requires.
          lz.normalize();
          if (lz.remainLen !== 0 || lz.inPos !== this.chunkEnd || lz.code !== 0) {
            throw corrupt('an LZMA2 chunk does not end where its header says');
          }
        }
        this.chunkKind = 0;
      }
    }
    var got = lz.dicPos - start;
    if (got === 0) throw corrupt('the LZMA2 data ended ' + this.remaining + ' bytes before the size recorded in the header');
    this.remaining -= got;
    if (this.remaining === 0) {
      // The block's recorded size is reached, so the stream must end here
      // too: the last chunk must be complete, and the next control byte (if
      // any) must be the 0x00 end marker, which 7-Zip and liblzma always
      // write. Without this, damage to a chunk's size field would go unseen
      // whenever the output itself happened to be unaffected - and py7zr
      // stores no CRC for its compressed header, so this framing is the only
      // check that header gets.
      if (this.chunkKind !== 0) throw corrupt('an LZMA2 chunk runs past the size recorded in the header');
      if (!this.ended && this.pos < this.input.length && this.input[this.pos] !== 0x00) {
        throw corrupt('the LZMA2 data continues past the size recorded in the header');
      }
    }
    return lz.dic.subarray(start, lz.dicPos);
  };

  // ------------------------------------------------------------------------
  // Coder ids (hex) -> what to call them in a refusal message.
  // ------------------------------------------------------------------------
  var SUPPORTED = { '00': 'Copy (no compression)', '030101': 'LZMA compression', '21': 'LZMA2 compression' };
  var METHOD_NAMES = {
    '06f10701': '7zAES encryption', '06f10101': 'ZipCrypto encryption', '06f10303': 'RAR encryption',
    '03': 'the Delta filter',
    '04': 'the BCJ (x86 executable) filter', '03030103': 'the BCJ (x86 executable) filter',
    '0303011b': 'the BCJ2 (x86 executable) filter',
    '05': 'the PowerPC executable filter', '03030205': 'the PowerPC executable filter',
    '06': 'the IA-64 executable filter', '03030401': 'the IA-64 executable filter',
    '07': 'the ARM executable filter', '03030501': 'the ARM executable filter',
    '08': 'the ARM Thumb executable filter', '03030701': 'the ARM Thumb executable filter',
    '09': 'the SPARC executable filter', '03030805': 'the SPARC executable filter',
    '0a': 'the ARM64 executable filter', '0b': 'the RISC-V executable filter',
    '030401': 'PPMd compression',
    '040108': 'Deflate compression', '040109': 'Deflate64 compression',
    '040202': 'BZip2 compression',
    '04f71101': 'Zstandard compression', '04f71102': 'Brotli compression',
    '04f71104': 'LZ4 compression', '04f71105': 'LZ5 compression', '04f71106': 'Lizard compression'
  };
  var ENCRYPTION_IDS = { '06f10701': true, '06f10101': true, '06f10303': true };
  var SUPPORTED_TEXT = 'This reader only handles archives packed with plain LZMA, LZMA2 or no compression ' +
    '(no filters, no password); extract this one with 7-Zip instead.';

  function methodName(id) {
    return SUPPORTED[id] || METHOD_NAMES[id] || ('an unknown method (id 0x' + (id || '?').toUpperCase() + ')');
  }
  function uniqueJoin(list) {
    var seen = [];
    list.forEach(function (s) { if (seen.indexOf(s) < 0) seen.push(s); });
    return seen.length < 2 ? seen.join('') : seen.slice(0, -1).join(', ') + ' and ' + seen[seen.length - 1];
  }

  // Refuse anything this reader cannot decode, naming the method. Called for
  // every folder that has to be decoded BEFORE any file is handed over.
  function checkFolder(folder, fileNames) {
    var where = '', i, c;
    if (fileNames && fileNames.length) {
      where = ' for ' + fileNames.slice(0, 3).map(function (s) { return '"' + s + '"'; }).join(', ') +
        (fileNames.length > 3 ? ' and ' + (fileNames.length - 3) + ' more file(s)' : '');
    }
    for (i = 0; i < folder.coders.length; i++) {
      c = folder.coders[i];
      if (ENCRYPTION_IDS[c.id]) {
        throw fail(E_ENCRYPTED, 'This archive is password protected (' + methodName(c.id) + '), so it cannot be ' +
          'opened here. Extract it with 7-Zip using the password, or ask the supplier for an unprotected copy.');
      }
    }
    var odd = [], usual = [];
    folder.coders.forEach(function (cd) { (SUPPORTED[cd.id] ? usual : odd).push(methodName(cd.id)); });
    if (odd.length) {
      throw fail(E_UNSUPPORTED, 'This 7z archive uses ' + uniqueJoin(odd) +
        (usual.length ? ' together with ' + uniqueJoin(usual) : '') + where + '. ' + SUPPORTED_TEXT);
    }
    c = folder.coders[0];
    if (folder.coders.length !== 1 || c.numIn !== 1 || c.numOut !== 1 || folder.packedStreams.length !== 1) {
      throw fail(E_UNSUPPORTED, 'This 7z archive chains ' + folder.coders.length + ' coders (' +
        folder.coders.map(function (cd) { return methodName(cd.id); }).join(' + ') + ')' + where + '. ' + SUPPORTED_TEXT);
    }
  }

  // Open a decoding stream over one folder's packed bytes.
  function openFolder(u8, folder) {
    var input = u8.subarray(folder.packOffset, folder.packOffset + folder.packSize);
    var c = folder.coders[0];
    if (c.id === '00') return new CopyStream(input, folder.unpackSize);
    if (c.id === '030101') return new LzmaStream(c.props, input, folder.unpackSize);
    return new Lzma2Stream(c.props, input, folder.unpackSize);
  }

  // ------------------------------------------------------------------------
  // Archive layout
  //
  //   offset 0   signature header (32 bytes): '7z\xBC\xAF\x27\x1C', version,
  //              CRC of the next 20 bytes, then the offset (from byte 32),
  //              size and CRC of the main header
  //   offset 32  packed streams (the compressed file data)
  //   ...        main header, at the very end of the file
  //
  // 7-Zip normally compresses the main header too: the "header" at the end
  // is then a kEncodedHeader, a small stream table describing where the real
  // (compressed) header sits among the packed streams.
  // ------------------------------------------------------------------------
  var SIGNATURE = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];

  function readFolderFully(u8, folder) {
    if (folder.unpackSize > MAX_HEADER_BYTES) throw corrupt('the archive header is implausibly large');
    var out = new Uint8Array(folder.unpackSize), stream = openFolder(u8, folder), pos = 0, v;
    while (pos < out.length) {
      v = stream.read(out.length - pos);
      out.set(v, pos);
      pos += v.length;
    }
    return out;
  }

  function parseArchive(u8) {
    var i;
    for (i = 0; i < 6; i++) {
      if (u8[i] !== SIGNATURE[i]) {
        throw fail(E_NOT_7Z, 'This is not a 7z archive (the 7z signature is missing). If it is the second or later ' +
          'part of a split archive (.7z.002 ...), open the .7z.001 part with all parts joined.');
      }
    }
    if (u8.length < 32) throw truncatedError(32, u8.length);
    if (u8[6] !== 0) {
      throw fail(E_UNSUPPORTED, 'This 7z archive uses format version ' + u8[6] + '.' + u8[7] +
        ', newer than this reader understands. Extract it with 7-Zip.');
    }
    if (crc32(u8.subarray(12, 32)) !== u32le(u8, 8)) throw corrupt('the signature header fails its CRC check');
    var nextOffset = u64le(u8, 12), nextSize = u64le(u8, 20), nextCrc = u32le(u8, 28);
    var info = {
      headerEncoded: false, headerFolders: [], nextHeaderOffset: nextOffset, nextHeaderSize: nextSize,
      files: [], folders: [], folderFiles: [], packCrcs: null, filePropIds: []
    };
    if (nextSize === 0) return info;                 // an empty archive
    var hStart = 32 + nextOffset, hEnd = hStart + nextSize;
    if (hEnd > u8.length) throw truncatedError(hEnd, u8.length);
    if (nextSize > MAX_HEADER_BYTES) throw corrupt('the archive header is implausibly large');
    if (crc32(u8.subarray(hStart, hEnd)) !== nextCrc) throw corrupt('the archive header fails its CRC check');

    var r = new Reader(u8, hStart, hEnd), t = r.number(), depth = 0;
    while (t === NID.kEncodedHeader) {
      if (++depth > 4) throw corrupt('the header is nested too deeply');
      var si = readStreamsInfo(r), parts = [], total = 0;
      if (!si.folders.length) throw corrupt('the compressed header has no data');
      locatePackStreams(si, u8.length, hStart);
      si.folders.forEach(function (f) {
        checkFolder(f, null);     // an encrypted header is refused here ("password protected")
        var out = readFolderFully(u8, f);
        if (f.crc !== null && crc32(out) !== f.crc) throw corrupt('the archive header fails its CRC check after decompression');
        parts.push(out);
        total += out.length;
        info.headerFolders.push(f);
      });
      var hdr = parts[0];
      if (parts.length > 1) {
        hdr = new Uint8Array(total);
        total = 0;
        parts.forEach(function (p) { hdr.set(p, total); total += p.length; });
      }
      info.headerEncoded = true;
      r = new Reader(hdr, 0, hdr.length);
      t = r.number();
    }
    if (t !== NID.kHeader) throw corrupt('unknown header type ' + t);
    var h = readHeader(r);
    var main = h.main || { pack: { packPos: 0, sizes: [], crcs: null }, folders: [], sub: { counts: [], sizes: [], crcs: [] } };
    locatePackStreams(main, u8.length, hStart);

    // Map the files that have data to the folders' streams, in order: the
    // n-th file with data is the n-th stream (folder 0's streams first).
    var files = h.files, folders = main.folders, sub = main.sub;
    var folderFiles = folders.map(function () { return []; });
    var fi = 0, inFolder = 0, s = 0;
    for (i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f.hasStream) continue;
      while (fi < folders.length && sub.counts[fi] === 0) fi++;
      if (fi >= folders.length) throw corrupt('the file list names more files than the archive holds');
      f.folderIndex = fi;
      f.subIndex = inFolder;
      f.size = sub.sizes[s];
      f.crc = sub.crcs[s];
      s++;
      folderFiles[fi].push(i);
      if (++inFolder >= sub.counts[fi]) { fi++; inFolder = 0; }
    }
    if (s !== sub.sizes.length) throw corrupt('the archive holds data that belongs to no file');
    info.files = files;
    info.folders = folders;
    info.folderFiles = folderFiles;
    info.packCrcs = main.pack.crcs;
    info.filePropIds = h.propIds;
    return info;
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  // list(u8) -> [{ name, size, isDir, crc, folderIndex }]
  // Reads the headers only (decompressing the header itself when it is
  // encoded, which is tiny); no file data is decoded. crc is the stored
  // CRC32 (unsigned) or null; folderIndex is null for entries without data
  // (directories and empty files). Encrypted or filtered archives still list
  // as long as their header is readable; extract() is what refuses them.
  function list(input) {
    var arc = parseArchive(toU8(input));
    return arc.files.filter(function (f) { return !f.isAnti; }).map(function (f) {
      return { name: f.name, size: f.size, isDir: f.isDir, crc: f.crc, folderIndex: f.folderIndex };
    });
  }

  var DEFAULT_CHUNK_BYTES = 4 << 20;   // size of each Uint8Array handed to onFile
  var READ_STEP = 1 << 20;             // output decoded per decoder call
  var PROGRESS_STEP = 4 << 20;         // onProgress at least this often
  var YIELD_MS = 40;                   // give the browser a turn this often

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  // Hand control back to the event loop so a browser tab stays responsive.
  // setTimeout is the obvious tool but browsers clamp it to 4 ms and, in a
  // background tab, throttle it to once a second or less, which would stall
  // an import the moment staff switch tabs. A MessageChannel message is a
  // plain task, not a timer, so it is neither clamped nor throttled. Node
  // uses setImmediate; anything else falls back to setTimeout.
  var yieldImpl = null;
  function yieldToEventLoop() {
    if (!yieldImpl) {
      if (typeof setImmediate === 'function') {
        yieldImpl = function () { return new Promise(function (resolve) { setImmediate(resolve); }); };
      } else if (typeof MessageChannel === 'function') {
        var channel = new MessageChannel(), waiting = [];
        channel.port1.onmessage = function () { var resolve = waiting.shift(); if (resolve) resolve(); };
        yieldImpl = function () {
          return new Promise(function (resolve) { waiting.push(resolve); channel.port2.postMessage(0); });
        };
      } else {
        yieldImpl = function () { return new Promise(function (resolve) { setTimeout(resolve, 0); }); };
      }
    }
    return yieldImpl();
  }

  // extract(u8, { onFile, onProgress, filter, chunkBytes }) -> { files, ms }
  //
  //   onFile({ name, size, chunks })  awaited once per file, in archive order.
  //       chunks is an array of Uint8Array whose concatenation is the file
  //       (new Blob(chunks) in a browser). The CRC32 has already been checked
  //       when onFile is called; the chunks are not touched afterwards.
  //       Directories are not passed (they have no data); empty files are,
  //       with size 0 and no chunks.
  //   filter(name)  return false (any falsy value) to skip a file. In a solid
  //       block the bytes before a wanted file still have to be decoded, but
  //       a skipped file's bytes are never kept, nothing after the last wanted
  //       file of a block is decoded, and a block with no wanted file is not
  //       decoded at all.
  //   onProgress({ done, total })  unpacked bytes decoded so far / to decode;
  //       called every 4 MB and at the end, and awaited.
  //   chunkBytes  size of the pieces in chunks (default 4 MB, minimum 64 KB).
  //
  // Memory: the archive itself, the decoder's dictionary (capped at the
  // block's size) and the current file's chunks. Every decoder that will be
  // needed is checked before the first onFile call, so a refusal (password,
  // unsupported filter) never follows partial output. Damage found mid-way
  // (CRC mismatch, truncated data) rejects the promise; the damaged file is
  // never passed to onFile.
  async function extract(input, options) {
    var t0 = now(), opts = options || {};
    var u8 = toU8(input), arc = parseArchive(u8);
    var onFile = typeof opts.onFile === 'function' ? opts.onFile : null;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var filter = typeof opts.filter === 'function' ? opts.filter : null;
    var chunkBytes = Math.max(65536, Math.floor(Number(opts.chunkBytes)) || DEFAULT_CHUNK_BYTES);
    var files = arc.files, folders = arc.folders, i, k;

    var wanted = files.map(function (f) {
      return !f.isDir && !f.isAnti && (!filter || !!filter(f.name));
    });
    // The last stream each folder must be decoded up to (-1: skip folder).
    var lastNeeded = folders.map(function () { return -1; });
    files.forEach(function (f, idx) {
      if (wanted[idx] && f.hasStream && f.subIndex > lastNeeded[f.folderIndex]) lastNeeded[f.folderIndex] = f.subIndex;
    });
    var total = 0;
    for (k = 0; k < folders.length; k++) {
      if (lastNeeded[k] < 0) continue;
      checkFolder(folders[k], arc.folderFiles[k].map(function (idx) { return files[idx].name; }));
      for (i = 0; i <= lastNeeded[k]; i++) total += files[arc.folderFiles[k][i]].size;
    }

    var done = 0, lastReport = 0, lastYield = now(), names = [];
    var stream = null, streamFolder = -1, folderCrc = -1, checkFolderCrc = false;

    for (i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.isDir || f.isAnti) continue;
      if (!f.hasStream) {
        if (wanted[i]) {
          if (onFile) await onFile({ name: f.name, size: 0, chunks: [] });
          names.push(f.name);
        }
        continue;
      }
      k = f.folderIndex;
      if (f.subIndex > lastNeeded[k]) continue;
      if (streamFolder !== k) {
        stream = openFolder(u8, folders[k]);
        streamFolder = k;
        // A folder CRC over several files is only checkable if the whole
        // folder is decoded; single-file folders use it as the file CRC.
        checkFolderCrc = folders[k].crc !== null && arc.folderFiles[k].length > 1 &&
          lastNeeded[k] === arc.folderFiles[k].length - 1;
        folderCrc = -1;
      }

      var keep = wanted[i] && onFile !== null;
      var chunks = keep ? [] : null, cur = null, curPos = 0, left = f.size, crc = -1;
      while (left > 0) {
        var view = stream.read(left < READ_STEP ? left : READ_STEP), n = view.length, off = 0, take;
        crc = crc32Update(crc, view, 0, n);
        if (checkFolderCrc) folderCrc = crc32Update(folderCrc, view, 0, n);
        if (keep) {
          while (off < n) {
            if (cur === null) { cur = new Uint8Array(Math.min(chunkBytes, left - off)); curPos = 0; }
            take = Math.min(n - off, cur.length - curPos);
            cur.set(take === n ? view : view.subarray(off, off + take), curPos);
            curPos += take;
            off += take;
            if (curPos === cur.length) { chunks.push(cur); cur = null; }
          }
        }
        left -= n;
        done += n;
        if (onProgress && done - lastReport >= PROGRESS_STEP) {
          lastReport = done;
          await onProgress({ done: done, total: total });
        }
        if (now() - lastYield >= YIELD_MS) {
          await yieldToEventLoop();
          lastYield = now();
        }
      }
      if (f.crc !== null && crc32Final(crc) !== f.crc) {
        throw fail(E_CRC, 'The file "' + f.name + '" in this archive fails its CRC check (stored ' + hex8(f.crc) +
          ', decoded ' + hex8(crc32Final(crc)) + '), so the archive is damaged. Ask the supplier to resend it.');
      }
      if (checkFolderCrc && f.subIndex === arc.folderFiles[k].length - 1 && crc32Final(folderCrc) !== folders[k].crc) {
        throw fail(E_CRC, 'A block of this archive fails its CRC check (stored ' + hex8(folders[k].crc) +
          ', decoded ' + hex8(crc32Final(folderCrc)) + '), so the archive is damaged. Ask the supplier to resend it.');
      }
      if (wanted[i]) {
        if (onFile) await onFile({ name: f.name, size: f.size, chunks: chunks });
        names.push(f.name);
      }
      chunks = null;
      cur = null;
    }
    if (onProgress) await onProgress({ done: done, total: total });
    return { files: names, ms: Math.round(now() - t0) };
  }

  // Header facts for diagnostics and tests: whether the header is encoded,
  // and each folder's coders, dictionary size and CRC presence.
  function inspect(input) {
    var arc = parseArchive(toU8(input));
    function describeFolder(f) {
      return {
        coders: f.coders.map(function (c) {
          var d = { id: c.id, method: methodName(c.id) };
          if (c.id === '030101' && c.props && c.props.length >= 5) {
            d.lc = c.props[0] % 9; d.lp = Math.floor(c.props[0] / 9) % 5; d.pb = Math.floor(c.props[0] / 45);
            d.dictSize = u32le(c.props, 1);
          } else if (c.id === '21' && c.props && c.props.length >= 1) {
            var b = c.props[0];
            d.dictSize = b === 40 ? 4294967295 : (2 | (b & 1)) * Math.pow(2, (b >>> 1) + 11);
          }
          return d;
        }),
        packSize: f.packSize, unpackSize: f.unpackSize, crcDefined: f.crc !== null
      };
    }
    return {
      headerEncoded: arc.headerEncoded,
      headerFolders: arc.headerFolders.map(describeFolder),
      folders: arc.folders.map(describeFolder),
      numFiles: arc.files.length,
      filesWithCrc: arc.files.filter(function (f) { return f.crc !== null; }).length,
      packCrcsDefined: !!(arc.packCrcs && arc.packCrcs.some(function (c) { return c !== null; })),
      // FilesInfo property ids present, e.g. 0x11 names, 0x14 mtime,
      // 0x15 attributes, 0x19 kDummy padding.
      filePropIds: arc.filePropIds.slice()
    };
  }

  // Raw single-stream helpers (used by the tests to exercise the decoders
  // directly on liblzma output).
  function decodeAll(stream, outSize) {
    var out = new Uint8Array(outSize), pos = 0, v;
    while (pos < outSize) { v = stream.read(outSize - pos); out.set(v, pos); pos += v.length; }
    return out;
  }

  root.SevenZip = {
    VERSION: VERSION,
    list: list,
    extract: extract,
    _internals: {
      crc32: crc32, crc32Update: crc32Update, crc32Final: crc32Final,
      parseArchive: parseArchive, inspect: inspect, checkFolder: checkFolder, methodName: methodName,
      LzmaDecoder: LzmaDecoder,
      decodeLzma: function (props, input, outSize) { return decodeAll(new LzmaStream(toU8(props), toU8(input), outSize), outSize); },
      decodeLzma2: function (props, input, outSize) { return decodeAll(new Lzma2Stream(toU8(props), toU8(input), outSize), outSize); },
      decodeCopy: function (input, outSize) { return decodeAll(new CopyStream(toU8(input), outSize), outSize); }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).SevenZip;
