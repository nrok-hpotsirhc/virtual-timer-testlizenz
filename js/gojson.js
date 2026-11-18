/* Strenges JSON wie im Produkt und JSON-Ausgabe wie Go (encoding/json, Toolchain aus go.mod des
   Produkts). Maßgeblich sind license.DecodeStrict (internal/license/strict.go) und json.Marshal.

   parse liest genau einen JSON-Wert in einen Baum, der die Reihenfolge der Felder behält:
   - nur die Grammatik von RFC 8259 (wie der Scanner von Go): kein BOM, keine Kommentare, keine
     führenden Nullen, keine Steuerzeichen in Texten, nichts nach dem Wert;
   - doppelte Schlüssel in einem Objekt sind ein Fehler (AL-15);
   - Escapes wie Go: ein einzelnes Surrogat aus \uXXXX wird zu U+FFFD, ein gültiges Paar zu einem
     Zeichen.

   marshal schreibt wie json.Marshal: Felder in Reihenfolge des Objekts, Maps (Map) nach UTF-8-Bytes
   sortiert, HTML-Zeichen und U+2028/U+2029 maskiert, \b und \f kurz, Zeitpunkte als RFC 3339 in UTC.
   Felder mit undefined entfallen (omitempty bei Zeigern). */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.VTL = root.VTL || {}).gojson = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_DEPTH = 64; // Formate des Produkts sind höchstens 3 Ebenen tief

  class JsonError extends Error {}

  function parse(text, options) {
    const allowDuplicates = Boolean(options && options.allowDuplicates);
    const n = text.length;
    let i = 0;

    function fail(message) {
      throw new JsonError(message);
    }
    function skipSpace() {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
        i++;
      }
    }
    function hex4(at) {
      if (at + 4 > n) return -1;
      const s = text.slice(at, at + 4);
      return /^[0-9A-Fa-f]{4}$/.test(s) ? parseInt(s, 16) : -1;
    }
    function string() {
      i++; // öffnendes Anführungszeichen
      let out = '';
      let start = i;
      for (;;) {
        if (i >= n) fail('Text ohne Ende');
        const c = text.charCodeAt(i);
        if (c === 0x22) {
          out += text.slice(start, i);
          i++;
          return out;
        }
        if (c < 0x20) fail('Steuerzeichen in einem Text');
        if (c !== 0x5c) {
          i++;
          continue;
        }
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const r = hex4(i);
            if (r < 0) fail('ungültiges \\u-Escape');
            i += 4;
            if (r >= 0xd800 && r < 0xe000) {
              // Go (unquoteBytes): nur ein hohes Surrogat mit folgendem tiefen ergibt ein Zeichen.
              if (r < 0xdc00 && text[i] === '\\' && text[i + 1] === 'u') {
                const r2 = hex4(i + 2);
                if (r2 >= 0xdc00 && r2 < 0xe000) {
                  out += String.fromCharCode(r, r2);
                  i += 6;
                  break;
                }
              }
              out += '\ufffd';
              break;
            }
            out += String.fromCharCode(r);
            break;
          }
          default:
            fail('ungültiges Escape in einem Text');
        }
        start = i;
      }
    }
    function number() {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
      if (!m) fail('ungültige Zahl');
      i += m[0].length;
      return { kind: 'number', raw: m[0] };
    }
    function literal(word, node) {
      if (text.slice(i, i + word.length) !== word) fail('unbekanntes Wort');
      i += word.length;
      return node;
    }
    function value(depth) {
      if (depth > MAX_DEPTH) fail('zu tief verschachtelt');
      skipSpace();
      if (i >= n) fail('unerwartetes Ende');
      const c = text[i];
      if (c === '{') return object(depth);
      if (c === '[') return array(depth);
      if (c === '"') return { kind: 'string', value: string() };
      if (c === 't') return literal('true', { kind: 'bool', value: true });
      if (c === 'f') return literal('false', { kind: 'bool', value: false });
      if (c === 'n') return literal('null', { kind: 'null' });
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      return fail('unerwartetes Zeichen');
    }
    function object(depth) {
      i++;
      const fields = [];
      const index = new Map();
      skipSpace();
      if (text[i] === '}') {
        i++;
        return { kind: 'object', fields };
      }
      for (;;) {
        skipSpace();
        if (text[i] !== '"') fail('Feldname erwartet');
        const key = string();
        skipSpace();
        if (text[i] !== ':') fail('Doppelpunkt erwartet');
        i++;
        const v = value(depth + 1);
        if (index.has(key)) {
          if (!allowDuplicates) fail('Feld „' + key + '“ doppelt');
          fields[index.get(key)][1] = v; // nachsichtig wie json.Unmarshal: der letzte Wert gilt
        } else {
          index.set(key, fields.length);
          fields.push([key, v]);
        }
        skipSpace();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return { kind: 'object', fields };
        }
        fail('Komma oder } erwartet');
      }
    }
    function array(depth) {
      i++;
      const items = [];
      skipSpace();
      if (text[i] === ']') {
        i++;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value(depth + 1));
        skipSpace();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return { kind: 'array', items };
        }
        fail('Komma oder ] erwartet');
      }
    }

    const root = value(0);
    skipSpace();
    if (i !== n) fail('Daten nach dem JSON-Wert');
    return root;
  }

  // Schema-Helfer wie encoding/json beim Dekodieren in Go-Typen; null ergibt den Nullwert.

  // fieldsOf: Objekt mit genau bekannten Feldnamen (Schreibweise exakt, AL-15).
  function fieldsOf(node, names) {
    if (node.kind !== 'object') throw new JsonError('Objekt erwartet');
    const out = new Map();
    for (const [key, v] of node.fields) {
      if (!names.includes(key)) throw new JsonError('Feld „' + key + '“ unbekannt (Schreibweise beachten)');
      out.set(key, v);
    }
    return out;
  }

  function asString(node) {
    if (node === undefined || node.kind === 'null') return '';
    if (node.kind !== 'string') throw new JsonError('Text erwartet');
    return node.value;
  }

  const INT64_MIN = -(2n ** 63n);
  const INT64_MAX = 2n ** 63n - 1n;

  // asInt wie int in Go (64 Bit): nur ganze Zahlen ohne Bruch und Exponent.
  function asInt(node) {
    if (node === undefined || node.kind === 'null') return 0;
    if (node.kind !== 'number' || !/^-?(?:0|[1-9][0-9]*)$/.test(node.raw)) throw new JsonError('ganze Zahl erwartet');
    const v = BigInt(node.raw);
    if (v < INT64_MIN || v > INT64_MAX) throw new JsonError('Zahl zu groß');
    // Außerhalb des sicheren Bereichs zählt nur, dass jede Grenze des Produkts (höchstens 9999) verfehlt wird.
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    if (v < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(v);
  }

  // asStringMap wie map[string]string: null bleibt null (nil), Werte null werden "".
  function asStringMap(node) {
    if (node === undefined || node.kind === 'null') return null;
    if (node.kind !== 'object') throw new JsonError('Objekt erwartet');
    const out = new Map();
    for (const [key, v] of node.fields) out.set(key, asString(v));
    return out;
  }

  // asStringList wie []string: null bleibt null (nil), Einträge null werden "".
  function asStringList(node) {
    if (node === undefined || node.kind === 'null') return null;
    if (node.kind !== 'array') throw new JsonError('Liste erwartet');
    return node.items.map(asString);
  }

  // ---------- Ausgabe wie json.Marshal ----------

  // wellFormed ersetzt einzelne Surrogate durch U+FFFD, wie ein Browser beim Absenden eines
  // Formulars (UTF-8). So entsteht dieselbe Bytefolge wie in licensectl serve.
  function wellFormed(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          out += text[i] + text[i + 1];
          i++;
          continue;
        }
      }
      out += c >= 0xd800 && c < 0xe000 ? '\ufffd' : text[i];
    }
    return out;
  }

  const HEX = '0123456789abcdef';

  function encodeString(text) {
    const s = wellFormed(text);
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += '\\\\';
      else if (c === 0x08) out += '\\b';
      else if (c === 0x0c) out += '\\f';
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0d) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 0x20 || c === 0x3c || c === 0x3e || c === 0x26) out += '\\u00' + HEX[c >> 4] + HEX[c & 15];
      else if (c === 0x2028 || c === 0x2029) out += '\\u202' + HEX[c & 15];
      else out += s[i];
    }
    return out + '"';
  }

  // compareUtf8 vergleicht wie strings.Compare in Go (Bytefolge in UTF-8 = Codepunkte), nicht nach
  // UTF-16-Einheiten wie der Vergleich in JavaScript.
  function compareUtf8(a, b) {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }

  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  // formatTime wie time.Time.MarshalJSON für Zeitpunkte in UTC mit ganzen Sekunden.
  function formatTime(d) {
    const ms = d.getTime();
    if (!Number.isFinite(ms) || ms % 1000 !== 0) throw new JsonError('Zeitpunkt ohne ganze Sekunden');
    const y = d.getUTCFullYear();
    if (y < 0 || y > 9999) throw new JsonError('Jahr außerhalb 0000 bis 9999');
    return pad(y, 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' +
      pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + 'Z';
  }

  function marshal(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') return encodeString(v);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new JsonError('nur ganze Zahlen');
      return String(v);
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return '"' + formatTime(v) + '"';
    if (Array.isArray(v)) return '[' + v.map(marshal).join(',') + ']';
    if (v instanceof Map) {
      const keys = Array.from(v.keys()).sort(compareUtf8);
      return '{' + keys.map((k) => encodeString(k) + ':' + marshal(v.get(k))).join(',') + '}';
    }
    if (typeof v === 'object') {
      const parts = [];
      for (const k of Object.keys(v)) {
        if (v[k] !== undefined) parts.push(encodeString(k) + ':' + marshal(v[k]));
      }
      return '{' + parts.join(',') + '}';
    }
    throw new JsonError('Typ nicht unterstützt');
  }

  // marshalIndentFlat wie json.MarshalIndent(v, "", "  ") für ein Objekt aus Texten (Hülle der Lizenz).
  function marshalIndentFlat(obj) {
    const lines = Object.keys(obj).map((k) => '  ' + encodeString(k) + ': ' + encodeString(obj[k]));
    return '{\n' + lines.join(',\n') + '\n}';
  }

  return {
    JsonError,
    parse,
    fieldsOf,
    asString,
    asInt,
    asStringMap,
    asStringList,
    wellFormed,
    encodeString,
    compareUtf8,
    formatTime,
    marshal,
    marshalIndentFlat,
  };
});
