const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'tapd_pending_to_pass.user.js'), 'utf8');
const feature = source.slice(source.indexOf('  const PLAN_QUEUE_KEY'), source.indexOf('\n  if (/'));
const statusHelpers = source.slice(source.indexOf('  function resultSpan('), source.indexOf('  function batchFailure('));
const apiHelpers = source.slice(source.indexOf('  async function waitForRowsPassed('), source.indexOf('  async function executeBatchRows('));
const selectionHelpers = source.slice(source.indexOf('  function isAvailable('), source.indexOf('  async function executeBatch('));
const origin = 'https://tapd.tencent.com';
const listUrl = origin + '/DFM_TEST/sparrow/test_plan/plan_list?data[Filter][status][]=%E5%BC%80%E5%90%AF&conf_id=1&select_workspace=20428366';

function plan(id = '101', status = '开启') {
  return { id, workspace: '20428366', name: '计划 ' + id, status,
    detailUrl: origin + '/20428366/sparrow/test_plan/detail/' + id,
    viewUrl: origin + '/20428366/sparrow/test_plan/view/' + id, sourceUrl: listUrl };
}

function planRow(p) {
  const link = (href) => ({ textContent: p.name, getAttribute: () => href });
  return {
    getAttribute: (name) => name === 'item_id' ? p.id : p.workspace,
    querySelector(selector) {
      if (selector.includes('pop_select_simple')) return { getAttribute: () => p.status, querySelector: () => ({ textContent: p.status }) };
      if (selector.includes('.field_name')) return link(p.viewUrl);
      if (selector.includes('/detail/')) return p.detailUrl ? link(p.detailUrl) : null;
      if (selector.includes('/view/')) return link(p.viewUrl);
      return null;
    },
  };
}

function harness(options = {}) {
  const p = plan();
  const state = { clock: 1000, fetches: [], navigation: [], submissions: 0, requests: [], selected: 0, serverPassed: false, message: '', progress: [] };
  const storage = new Map();
  const makeCase = (index) => {
    const checkbox = { checked: false, disabled: !!options.noPermission, closest: () => null };
    const span = { passed: !!options.alreadyPassed, getAttribute: () => span.passed ? 'pass' : 'untested',
      textContent: '未执行', closest: () => null, classList: { contains: () => false } };
    return { id: 'case-' + index, checkbox, span, getAttribute: () => 'case-' + index,
      querySelector: (selector) => selector.includes('checkbox') ? checkbox : span };
  };
  const cases = Array.from({ length: options.count ?? 3 }, (_, i) => makeCase(i));
  const header = { checked: false, closest: () => null, getClientRects: () => [1], click() {
    header.checked = !header.checked;
    state.selected += 1;
    cases.forEach((row, i) => { row.checkbox.checked = header.checked && !(options.incomplete && i === 1); });
  } };
  const listRows = (options.listPlans || [p]).map(planRow);
  const latestRows = (options.latestPlans || [p]).map(planRow);
  const listRoot = { querySelector: () => ({}), querySelectorAll: () => latestRows };
  const document = {
    body: { innerText: '用例个数：' + (options.total ?? cases.length) },
    querySelector(selector) {
      if (selector === '#plan_list_contents') return {};
      return cases.find((row) => selector.includes('item_id="' + row.id + '"')) || null;
    },
    querySelectorAll(selector) {
      if (selector === '#plan_list_contents tr[item_id]') return listRows;
      if (selector === 'tr.tcase_row') return cases.slice();
      if (selector.includes('select_all')) return [header];
      if (selector.includes('font-unfold')) return [];
      throw new Error('Unexpected selector: ' + selector);
    },
  };
  const at = new URL(options.onList ? listUrl : p.detailUrl);
  const location = { href: at.href, origin: at.origin, pathname: at.pathname,
    assign: (url) => state.navigation.push(url), reload: () => {
      state.navigation.push('reload');
      if (state.serverPassed) cases.forEach((row) => { row.span.passed = true; });
    } };
  let api;
  const context = { document, location, URL, URLSearchParams, AbortController,
    window: { TFL: options.wrongPlanId ? { TestPlanDetail: { Tcase: { config: {
      plan_id: '999', tcase_instance_base_url: '/20428366/sparrow/tcase_instance/' } } } } : undefined,
      $: { ajax(request) {
        state.submissions += 1;
        state.requests.push({ url: request.url, data: request.data });
        if (options.apiReject) { request.success('false'); return; }
        state.serverPassed = !options.timeout;
        request.success('true');
      } } },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem(key, value) { if (options.storageFailure) throw Error('storage full'); storage.set(key, value); } },
    Date: { now: () => state.clock }, setTimeout, clearTimeout,
    DOMParser: class { parseFromString() { return listRoot; } },
    fetch: async (url) => {
      state.fetches.push(url);
      if (options.networkFailure) throw Error('network unavailable');
      return { ok: true, url, text: async () => 'list fixture' };
    },
    sleep: async (ms) => { state.clock += ms; if (options.pauseAfterSubmit && state.submissions) api.pause(); },
    CSS: { escape: (value) => value }, console: { warn() {} },
    setMessage: (value) => { state.message = value; }, setProgress: (done, total) => { state.progress = [done, total]; },
  };
  api = vm.runInNewContext("const PASS_STATUS_VALUES=['status_pass','pass']; const PASS_TEXT_REGEX=/^\\s*通过\\s*$/; const BATCH_SIZE=10; let stopRequested=false;\n"
    + feature + statusHelpers + apiHelpers + selectionHelpers
    + '\n({collectOpenPlans, planListScope, planCaseTotal, savePlanQueue, loadPlanQueue, currentQueuedPlan, runQueuedPlan, queueSummary, pause:()=>{stopRequested=true;}})', context);
  const queue = { version: 1, status: 'running', phase: 'ready', plans: [p, plan('102')], cursor: 0, results: [], returnUrl: listUrl, updatedAt: state.clock };
  return { api, queue, state, cases, storage, document, location };
}

test('collects only current-page open rows; never fetches another page', () => {
  const h = harness({ onList: true, listPlans: [plan(), plan('102', '关闭'), plan('103'), plan()] });
  assert.deepEqual(Array.from(h.api.collectOpenPlans(), (p) => p.id), ['101', '103']);
  assert.equal(h.state.fetches.length, 0);
  assert.ok(h.api.collectOpenPlans()[0].sourceUrl.includes('%E5%BC%80%E5%90%AF'));
});

test('scope retains filters and page number', () => {
  const h = harness();
  assert.equal(h.api.planListScope(listUrl + '&async=1'), h.api.planListScope(listUrl));
  assert.notEqual(h.api.planListScope(listUrl + '&page=2'), h.api.planListScope(listUrl));
  assert.throws(() => h.api.planListScope('https://example.com/a'));
});

test('submits every selected case as pass in one request, then verifies after reload', async () => {
  const h = harness({ count: 124 }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 1);
  assert.equal(h.cases.filter((r) => r.checkbox.checked).length, 124);
  assert.equal(h.queue.phase, 'submitted');
  assert.deepEqual(h.state.navigation, ['reload']);
  const request = h.state.requests[0];
  const params = new URLSearchParams(request.data);
  assert.match(request.url, /execute_result\/batch_execute\/0\/$/);
  assert.equal(params.get('data[Result][result_status]'), 'pass');
  assert.equal(params.get('data[Result][test_plan_id]'), '101');
  assert.deepEqual(params.get('data[Result][tcase_id]').split(','), h.cases.map((r) => r.id));
  await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 1);
  assert.equal(h.queue.results[0].outcome, 'complete');
  assert.equal(h.queue.cursor, 1);
  assert.equal(h.state.navigation[1], h.queue.plans[1].detailUrl);
});

test('returns to the original filtered list after the final plan', async () => {
  const h = harness(); h.queue.plans.pop(); await h.api.runQueuedPlan(h.queue);
  await h.api.runQueuedPlan(h.queue);
  assert.equal(h.queue.status, 'done');
  assert.deepEqual(h.state.navigation, ['reload', listUrl]);
});

test('skips a plan that closed after the current-page snapshot', async () => {
  const h = harness({ latestPlans: [plan('101', '关闭')] }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'skipped');
});

test('skips a plan that no longer matches the filtered list', async () => {
  const h = harness({ latestPlans: [] }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'skipped');
});

test('does not reexecute an already-passed plan', async () => {
  const h = harness({ alreadyPassed: true }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'already-passed');
});

test('empty plans are explicitly recorded', async () => {
  const h = harness({ count: 0 }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'empty');
});

test('incomplete case loading prevents partial execution', async () => {
  const h = harness({ total: 8 }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'failed');
  assert.match(h.queue.results[0].detail, /完整用例列表/);
});

test('incomplete selection or missing permissions cannot submit', async () => {
  for (const options of [{ incomplete: true }, { noPermission: true }]) {
    const h = harness(options); await h.api.runQueuedPlan(h.queue);
    assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'failed');
  }
});

test('resumed submitted work only checks results; never posts again', async () => {
  const h = harness({ alreadyPassed: true }); h.queue.phase = 'submitted'; h.queue.itemIds = h.cases.map((r) => r.id);
  await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.state.fetches.length, 0);
  assert.equal(h.queue.results[0].outcome, 'complete');
});

test('unconfirmed requests are recorded and not repeated', async () => {
  const h = harness({ timeout: true }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.queue.phase, 'submitted');
  await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 1); assert.equal(h.queue.results[0].outcome, 'failed');
  assert.match(h.queue.results[0].detail, /不会重复提交/);
});

test('pause after submission preserves the verification phase', async () => {
  const h = harness({ timeout: true, pauseAfterSubmit: true }); await h.api.runQueuedPlan(h.queue);
  await h.api.runQueuedPlan(h.queue);
  assert.equal(h.queue.status, 'paused'); assert.equal(h.queue.phase, 'submitted');
  assert.equal(h.queue.cursor, 0); assert.deepEqual(h.state.navigation, ['reload']);
  assert.equal(h.state.submissions, 1); assert.equal(h.api.loadPlanQueue().phase, 'submitted');
});

test('rejected API response fails without reloading or resubmitting', async () => {
  const h = harness({ apiReject: true }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 1);
  assert.equal(h.queue.results[0].outcome, 'failed');
  assert.match(h.queue.results[0].detail, /不会自动重复提交/);
  assert.equal(h.state.navigation.includes('reload'), false);
});

test('queue storage failure prevents submission', async () => {
  const h = harness({ storageFailure: true });
  await assert.rejects(h.api.runQueuedPlan(h.queue), /storage full/);
  assert.equal(h.state.submissions, 0);
});

test('network failure is reported per plan and advances the queue', async () => {
  const h = harness({ networkFailure: true }); await h.api.runQueuedPlan(h.queue);
  assert.equal(h.state.submissions, 0); assert.equal(h.queue.results[0].outcome, 'failed');
  assert.equal(h.queue.cursor, 1);
});

test('other plan pages cannot participate in the saved queue', () => {
  const h = harness(); h.location.pathname = '/20428366/sparrow/test_plan/detail/999';
  assert.equal(h.api.currentQueuedPlan(h.queue), null);
});

test('old queues require manual resumption', () => {
  const h = harness(); h.api.savePlanQueue(h.queue); h.state.clock += 13 * 60 * 60 * 1000;
  assert.equal(h.api.loadPlanQueue().status, 'paused');
});
