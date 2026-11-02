// host API 纯函数单测：同源判定、completion 输入适配、轮次文档适配、判据投影。
// 只 import 包内相对路径，不依赖宿主运行时。
import test from 'node:test';
import assert from 'node:assert/strict';

import { criterionRows, completionInput, isAllowedOrigin, roundsOf } from '../server/api.js';

test('isAllowedOrigin：同源放行、跨源拒绝、无 Origin 放行', () => {
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:52019'), true);
  assert.equal(isAllowedOrigin('', '127.0.0.1:52019'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:52019', '127.0.0.1:52019'), true);
  assert.equal(isAllowedOrigin('https://127.0.0.1:52019', '127.0.0.1:52019'), true);
  assert.equal(isAllowedOrigin('http://evil.example', '127.0.0.1:52019'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:52020', '127.0.0.1:52019'), false);
  assert.equal(isAllowedOrigin('null', '127.0.0.1:52019'), false);
  assert.equal(isAllowedOrigin('not a url', '127.0.0.1:52019'), false);
  assert.equal(isAllowedOrigin('file:///x', '127.0.0.1:52019'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:52019', ''), false);
});

test('completionInput：把 loadProject.hashes 投影成 completion 读取的版本字段', () => {
  const input = completionInput({
    root: 'X:/p',
    hashes: { buildHash: 'sha256:build', sourceHash: 'sha256:src' },
    contract: { contractVersion: '1.2.3' }
  });
  assert.equal(input.buildHash, 'sha256:build');
  assert.equal(input.sourceHash, 'sha256:src');
  assert.equal(input.contractVersion, '1.2.3');
  assert.equal(input.adapterVersion, 'modelcheck-adapter/1');
  assert.equal(input.root, 'X:/p');
});

test('completionInput：没有 hashes 时保留 null，不伪造版本', () => {
  const input = completionInput({ contract: { contractVersion: '1.0.0' } });
  assert.equal(input.buildHash, null);
  assert.equal(input.sourceHash, null);
});

test('roundsOf：兼容数组与 {schemaVersion, rounds:[]} 文档', () => {
  assert.deepEqual(roundsOf(null), []);
  assert.deepEqual(roundsOf({ rounds: [{ round: 1 }] }), [{ round: 1 }]);
  assert.deepEqual(roundsOf([{ round: 1 }]), [{ round: 1 }]);
  assert.deepEqual(roundsOf({}), []);
});

test('criterionRows：契约判据 + 证据状态投影', () => {
  const project = {
    contract: {
      contractVersion: '1.0.0',
      criteria: [
        { id: 'GEO-X', level: 'P0', blocking: true, claim: '断言', method: 'auto', acceptance: 'auto', requiredEvidence: 'runtime', component: 'c1', source: { doc: 'd' } }
      ]
    },
    evidence: {
      entries: {
        'GEO-X': {
          status: 'pass', measured: { distance: 0.01 }, assertion: 'distance <= 0.03',
          evidenceKind: 'runtime', capturedAt: 'now', key: 'sha256:k', artifacts: []
        }
      }
    }
  };
  const rows = criterionRows(project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'GEO-X');
  assert.equal(rows[0].status, 'pass');
  assert.equal(rows[0].blocking, true);
  assert.equal(rows[0].requiredEvidence, 'runtime');
  assert.equal(rows[0].evidenceKey, 'sha256:k');
  assert.deepEqual(rows[0].measured, { distance: 0.01 });
});

test('criterionRows：无契约/无证据时给 unverified', () => {
  assert.deepEqual(criterionRows({ contract: null, evidence: null }), []);
  const rows = criterionRows({
    contract: { criteria: [{ id: 'A', level: 'P1', blocking: false, claim: 'x', method: 'manual' }] },
    evidence: { entries: {} }
  });
  assert.equal(rows[0].status, 'unverified');
  assert.equal(rows[0].blocking, false);
});
