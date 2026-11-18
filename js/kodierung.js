/* Kodierungen ohne Abhängigkeiten: UTF-8, Base64 (Standard mit Auffüllung, URL ohne Auffüllung),
   Hex. Klassisches Skript mit UMD-Hülle: im Browser unter VTL.kodierung, in Node per require
   (ES-Module lädt kein Browser von file://, README „Technik“). */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.VTL = root.VTL || {}).kodierung = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encoder = new TextEncoder();

  function utf8(text) {
    return encoder.encode(text);
  }

  // fromUtf8 dekodiert streng: ungültiges UTF-8 ist ein Fehler (kein stilles Ersatzzeichen), ein
  // BOM bleibt als Zeichen stehen und fällt so beim JSON-Lesen auf (wie in Go).
  function fromUtf8(bytes) {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }

  function encode(bytes, alphabet, pad) {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
      const n = bytes[i] << 16;
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (pad ? '==' : '');
    } else if (rest === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (pad ? '=' : '');
    }
    return out;
  }

  // decode prüft streng: nur Zeichen des Alphabets, Auffüllung genau nach Vorgabe, keine
  // überzähligen Bits (wie encoding/base64 in Go mit Strict). null bei Fehlern.
  function decode(text, alphabet, pad) {
    if (typeof text !== 'string') return null;
    let body = text;
    if (pad) {
      if (text.length % 4 !== 0) return null;
      const m = /={0,2}$/.exec(text);
      body = text.slice(0, text.length - m[0].length);
      if (body.length % 4 === 1) return null;
      if ((m[0].length === 1 && body.length % 4 !== 3) || (m[0].length === 2 && body.length % 4 !== 2)) return null;
    } else if (body.length % 4 === 1) {
      return null;
    }
    const out = new Uint8Array(Math.floor((body.length * 3) / 4));
    let bits = 0;
    let value = 0;
    let o = 0;
    for (let i = 0; i < body.length; i++) {
      const v = alphabet.indexOf(body[i]);
      if (v < 0) return null;
      value = (value << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (value >> bits) & 0xff;
      }
    }
    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
    return out;
  }

  function hex(bytes) {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }

  function fromHex(text) {
    if (!/^(?:[0-9a-f]{2})*$/.test(text)) return null;
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
    return out;
  }

  function equal(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  return {
    utf8,
    fromUtf8,
    base64: (b) => encode(b, STD, true),
    fromBase64: (t) => decode(t, STD, true),
    base64url: (b) => encode(b, URL, false),
    fromBase64url: (t) => decode(t, URL, false),
    hex,
    fromHex,
    equal,
  };
});
