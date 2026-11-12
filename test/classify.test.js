'use strict';
process.env.SESSION_SECRET = 't';
const assert = require('assert'); const L = require('../lib');
const P = [['911','real'],['1911','real'],['933','test'],['1933','test'],['19133','test'],['15555550911','test'],['5555550911','test']].map(([pattern, c]) => ({ pattern, class: c }));
const k = (...n) => L.classify(n, P);
assert.deepStrictEqual(k('911'), { class: 'real', pattern: '911' });
assert.deepStrictEqual(k('+1911'), { class: 'real', pattern: '1911' });
assert.strictEqual(k('933').class, 'test');
assert.strictEqual(k('5555550911').class, 'test');
assert.strictEqual(k('15555550911').class, 'test');
assert.strictEqual(k('9115551234'), null);          // normal number starting 911: not an emergency call
assert.strictEqual(k('18005550911'), null);
assert.strictEqual(k('1933', '911').class, 'real'); // real wins if any field is 911
assert.strictEqual(k(null, ''), null);
const t = L.makeToken(7); assert.strictEqual(L.readToken(t), 7); assert.strictEqual(L.readToken(t + 'x'), null);
assert.ok(L.checkPassword('correct horse', L.hashPassword('correct horse'))); assert.ok(!L.checkPassword('nope', L.hashPassword('x')));
console.log('classify/auth tests passed');
