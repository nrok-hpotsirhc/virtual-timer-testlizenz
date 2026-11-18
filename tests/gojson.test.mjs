// Strenges JSON und Ausgabe wie Go. Erwartungswerte der Ausgabe stammen aus encoding/json der
// Toolchain des Produkts (Go 1.27.4, gemessen am 2026-11-18); die Gegenprobe vergleicht zusätzlich
// zur Laufzeit Byte für Byte mit licensectl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gojson = require('../js/gojson.js');

const ok = (text) => gojson.parse(text);
const bad = (text, pattern) => assert.throws(() => gojson.parse(text), pattern || gojson.JsonError, text);

test('Grammatik wie RFC 8259: gültige Werte', () => {
  assert.equal(ok(' {"a" : [1, -0, 1.5e+3, true, false, null, "x"]}\n\r\t ').kind, 'object');
  assert.deepEqual(ok('-0'), { kind: 'number', raw: '-0' });
  assert.equal(ok('"\\u00e9\\/"').value, 'é/');
});

test('Grammatik: abgewiesen', () => {
  for (const t of ['', ' ', '{', '{"a":1,}', '[1,]', '01', '+1', '1.', '.5', '1e', 'tru', 'nul', '"a', "'a'",
    '{"a" 1}', '{a:1}', '"\\x"', '"\\u12"', '"\\\'"', '{} {}', '{}x', '\ufeff{}', '"a\tb"', '"a\u0000b"', 'NaN', '[1 2]']) {
    bad(t);
  }
});

test('doppelte Schlüssel sind ein Fehler, auch verschachtelt (AL-15)', () => {
  bad('{"a":1,"a":2}', /doppelt/);
  bad('{"x":{"b":"1","b":"2"}}', /doppelt/);
  // nachsichtig nur auf ausdrücklichen Wunsch (Meldung bei verwechselten Dateien)
  const n = gojson.parse('{"a":1,"a":2}', { allowDuplicates: true });
  assert.deepEqual(n.fields, [['a', { kind: 'number', raw: '2' }]]);
});

test('Schachtelung begrenzt', () => {
  assert.equal(ok('['.repeat(60) + ']'.repeat(60)).kind, 'array');
  bad('['.repeat(70) + ']'.repeat(70), /verschachtelt/);
});

test('Surrogate wie Go: einzeln wird U+FFFD, Paar ein Zeichen', () => {
  assert.equal(ok('"\\ud800"').value, '\ufffd');
  assert.equal(ok('"\\ud800A"').value, '\ufffdA');
  assert.equal(ok('"\\udc00\\ud800\\udc00"').value, '\ufffd\u{10000}');
  assert.equal(ok('"\\ud83d\\ude00"').value, '😀');
  assert.equal(ok('"\\ud800\\u0041"').value, '\ufffdA');
});

test('fieldsOf: exakte Feldnamen (Schreibweise)', () => {
  const names = ['format', 'installationId'];
  assert.equal(gojson.fieldsOf(ok('{"format":"x"}'), names).get('format').value, 'x');
  assert.throws(() => gojson.fieldsOf(ok('{"Format":"x"}'), names), /unbekannt/);
  assert.throws(() => gojson.fieldsOf(ok('{"INSTALLATIONID":"x"}'), names), /unbekannt/);
  assert.throws(() => gojson.fieldsOf(ok('{"extra":1}'), names), /unbekannt/);
  assert.throws(() => gojson.fieldsOf(ok('[]'), names), /Objekt/);
});

test('Typen wie Go: null ergibt Nullwerte, falsche Typen sind Fehler', () => {
  assert.equal(gojson.asString(ok('null')), '');
  assert.throws(() => gojson.asString(ok('1')));
  assert.equal(gojson.asInt(ok('-0')), 0);
  assert.equal(gojson.asInt(ok('9999')), 9999);
  for (const t of ['1.0', '1e0', '"1"', 'true', '99999999999999999999']) assert.throws(() => gojson.asInt(ok(t)), t);
  assert.equal(gojson.asInt(ok('9223372036854775807')), Number.MAX_SAFE_INTEGER);
  assert.equal(gojson.asStringMap(ok('null')), null);
  assert.deepEqual(gojson.asStringMap(ok('{"a":null}')), new Map([['a', '']]));
  assert.throws(() => gojson.asStringMap(ok('{"a":1}')));
  assert.deepEqual(gojson.asStringList(ok('[null,"x"]')), ['', 'x']);
  assert.equal(gojson.asStringList(ok('null')), null);
});

test('Texte wie json.Marshal (Go 1.27.4)', () => {
  const cases = [
    ['\b\f\n\r\t\x00\x01\x1f\x7f', '"\\b\\f\\n\\r\\t\\u0000\\u0001\\u001f\x7f"'],
    ['"\\/', '"\\"\\\\/"'],
    ['<>&', '"\\u003c\\u003e\\u0026"'],
    ['\u2028\u2029', '"\\u2028\\u2029"'],
    ['\u0085\u00a0é€😀\ufffd\ue000\uffff', '"\u0085\u00a0é€😀\ufffd\ue000\uffff"'],
    ['Bühne & Licht <GmbH>', '"Bühne \\u0026 Licht \\u003cGmbH\\u003e"'],
  ];
  for (const [input, want] of cases) assert.equal(gojson.encodeString(input), want, JSON.stringify(input));
  // einzelne Surrogate wie aus einem Formular (UTF-8): U+FFFD
  assert.equal(gojson.encodeString('a\ud800b'), '"a\ufffdb"');
  assert.equal(gojson.encodeString('\udc00'), '"\ufffd"');
});

test('Maps nach UTF-8-Bytes sortiert wie Go, nicht nach UTF-16', () => {
  const m = new Map([['a', '1'], ['Z', '2'], ['é', '3'], ['\ue000', '4'], ['😀', '5'], ['\ufffd', '6'], ['10', '7'], ['9', '8'], ['', '9'], ['__proto__', 'x']]);
  assert.equal(gojson.marshal(m), '{"":"9","10":"7","9":"8","Z":"2","__proto__":"x","a":"1","é":"3","\ue000":"4","\ufffd":"6","😀":"5"}');
  assert.ok(gojson.compareUtf8('\ue000', '😀') < 0);
  assert.ok('\ue000' > '😀', 'Vergleich in JavaScript wäre anders');
});

test('Objekte: Reihenfolge der Felder, undefined entfällt, null bleibt', () => {
  assert.equal(gojson.marshal({ b: 1, a: undefined, c: null, d: [], e: ['x'], f: new Map() }), '{"b":1,"c":null,"d":[],"e":["x"],"f":{}}');
  assert.equal(gojson.marshal(new Date(Date.UTC(2026, 2, 3, 23, 30, 15))), '"2026-03-03T23:30:15Z"');
  assert.throws(() => gojson.marshal(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 5))));
  assert.throws(() => gojson.marshal(1.5));
});

test('Hülle wie json.MarshalIndent mit zwei Leerzeichen', () => {
  assert.equal(gojson.marshalIndentFlat({ format: 'timerd-license/1', kid: 'test-x', payload: 'AAA', sig: 'BBB' }),
    '{\n  "format": "timerd-license/1",\n  "kid": "test-x",\n  "payload": "AAA",\n  "sig": "BBB"\n}');
});

test('Rundlauf: parse(marshal(x)) liefert dieselben Texte', () => {
  for (const s of ['', 'a"b\\c', '\u2028<>&', '😀\ue000', '\u007f\u0085']) {
    assert.equal(gojson.parse(gojson.encodeString(s)).value, s);
  }
});
