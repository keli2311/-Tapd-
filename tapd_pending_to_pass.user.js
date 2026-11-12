// ==UserScript==
// @name         TAPD 测试计划：非通过用例批量改为通过
// @namespace    local.tapd.automation
// @version      2.5.1
// @description  当前页开启计划逐个全选，一次提交全部用例为 pass，并刷新核对结果。
// @match        https://tapd.tencent.com/*/sparrow/test_plan/plan_list*
// @match        https://tapd.tencent.com/*/sparrow/test_plan/view/*
// @match        https://tapd.tencent.com/*/sparrow/test_plan/detail/*
// @match        https://tapd.woa.com/*/sparrow/test_plan/plan_list*
// @match        https://tapd.woa.com/*/sparrow/test_plan/view/*
// @match        https://tapd.woa.com/*/sparrow/test_plan/detail/*
// @downloadURL  https://raw.githubusercontent.com/keli2311/-Tapd-/main/tapd_pending_to_pass.user.js
// @updateURL    https://raw.githubusercontent.com/keli2311/-Tapd-/main/tapd_pending_to_pass.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const PASS_STATUS_VALUES = ['status_pass', 'pass'];
  const PASS_TEXT_REGEX = /^\s*通过\s*$/;
  const BETWEEN_CASES_MS = 350;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 10000;
  const BATCH_SIZE = 10;
  const RETRY_STATE_KEY = 'tapdExecRetryState';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const PLAN_QUEUE_KEY = 'tapdOpenPlanQueueV1';
  const PLAN_QUEUE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  function planLink(href, kind, id) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const match = url.pathname.match(/^\/([^/]+)\/sparrow\/test_plan\/(view|detail)\/(\d+)\/?$/);
      return url.origin === location.origin && match && match[2] === kind && match[3] === id ? url.href : null;
    } catch (error) { return null; }
  }

  function planListScope(href) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !/\/sparrow\/test_plan\/plan_list\/?$/.test(url.pathname)) {
      throw new Error('计划列表链接不属于当前 TAPD 页面。');
    }
    ['async', 'action_timestamp'].forEach((key) => url.searchParams.delete(key));
    if (url.searchParams.get('page') === '1') url.searchParams.delete('page');
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  }

  function readPlanRows(root, pageUrl) {
    return [...root.querySelectorAll('#plan_list_contents tr[item_id]')].map((row) => {
      const id = row.getAttribute('item_id');
      const status = row.querySelector('[pop_select_simple="test_plan_status"][pop_workitem_id]');
      const nameLink = row.querySelector('.field_name a[href]');
      const detail = row.querySelector('a[href*="/test_plan/detail/"]');
      const view = nameLink || row.querySelector('a[href*="/test_plan/view/"]');
      return {
        id, workspace: row.getAttribute('data-workspace-id'), name: nameLink?.textContent?.trim() || id,
        status: (status?.getAttribute('title') || status?.querySelector('span')?.textContent || '').trim(),
        detailUrl: detail ? planLink(new URL(detail.getAttribute('href'), pageUrl).href, 'detail', id) : null,
        viewUrl: view ? planLink(new URL(view.getAttribute('href'), pageUrl).href, 'view', id) : null,
        sourceUrl: pageUrl,
      };
    });
  }

  async function fetchPlanDocument(href, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 30000);
    try {
      const response = await fetch(href, { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('页面读取失败（HTTP ' + response.status + '）。');
      if (response.url && planListScope(response.url) !== planListScope(href)) {
        throw new Error('页面跳转或筛选条件改变，请检查登录状态后重新扫描。');
      }
      const root = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (!root.querySelector('#plan_list_contents')) throw new Error('未读取到计划列表，请检查登录或访问权限。');
      return root;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function collectOpenPlans() {
    if (!document.querySelector('#plan_list_contents')) throw new Error('请等待测试计划列表加载完成。');
    const plans = new Map();
    for (const plan of readPlanRows(document, location.href)) {
      if (plan.status !== '开启') continue;
      if (!/^\d+$/.test(plan.id || '') || !plan.workspace || (!plan.detailUrl && !plan.viewUrl)) {
        throw new Error('有开启计划缺少有效的执行链接，未启动队列。');
      }
      plans.set(plan.workspace + ':' + plan.id, plan);
    }
    return [...plans.values()];
  }

  function savePlanQueue(queue) {
    queue.updatedAt = Date.now();
    sessionStorage.setItem(PLAN_QUEUE_KEY, JSON.stringify(queue));
  }

  function loadPlanQueue() {
    try {
      const queue = JSON.parse(sessionStorage.getItem(PLAN_QUEUE_KEY) || 'null');
      if (!queue || queue.version !== 1 || !Array.isArray(queue.plans) || !Array.isArray(queue.results)
        || !Number.isInteger(queue.cursor) || queue.cursor < 0 || queue.cursor > queue.plans.length
        || !['running', 'paused', 'done'].includes(queue.status) || !['ready', 'submitted'].includes(queue.phase)) return null;
      planListScope(queue.returnUrl);
      for (const plan of queue.plans) {
        if (!/^\d+$/.test(plan.id || '') || !plan.workspace
          || (!planLink(plan.detailUrl, 'detail', plan.id) && !planLink(plan.viewUrl, 'view', plan.id))) return null;
        planListScope(plan.sourceUrl);
      }
      if (Date.now() - queue.updatedAt > PLAN_QUEUE_MAX_AGE_MS && queue.status === 'running') queue.status = 'paused';
      return queue;
    } catch (error) { return null; }
  }

  function currentQueuedPlan(queue) {
    const plan = queue?.plans[queue.cursor];
    const match = location.pathname.match(/^\/([^/]+)\/sparrow\/test_plan\/(view|detail)\/(\d+)\/?$/);
    return queue?.status === 'running' && plan && match && match[1] === plan.workspace && match[3] === plan.id ? plan : null;
  }

  function navigatePlanQueue(queue) {
    if (queue.cursor >= queue.plans.length) {
      queue.status = 'done';
      savePlanQueue(queue);
      location.assign(queue.returnUrl);
      return;
    }
    const plan = queue.plans[queue.cursor];
    const href = planLink(plan.detailUrl, 'detail', plan.id) || planLink(plan.viewUrl, 'view', plan.id);
    if (!href) throw new Error('下一计划的执行链接无效。');
    savePlanQueue(queue);
    location.assign(href);
  }

  function finishQueuedPlan(queue, outcome, detail, total = 0) {
    const plan = queue.plans[queue.cursor];
    queue.results.push({ id: plan.id, name: plan.name, href: plan.detailUrl || plan.viewUrl, outcome, detail, total });
    queue.cursor += 1;
    queue.phase = 'ready';
    delete queue.itemIds;
    delete queue.pendingIds;
    delete queue.requestConfirmed;
    if (queue.status === 'paused') { savePlanQueue(queue); return; }
    navigatePlanQueue(queue);
  }

  function queueSummary(queue) {
    const count = (values) => queue.results.filter((r) => values.includes(r.outcome)).length;
    return '计划进度 ' + queue.cursor + '/' + queue.plans.length + '：完成 ' + count(['complete', 'already-passed'])
      + '，空计划 ' + count(['empty']) + '，失败/待确认 ' + count(['failed']) + '，状态改变跳过 ' + count(['skipped']) + '。';
  }

  function createPlanQueuePanel() {
    const panel = document.createElement('div');
    panel.id = 'tapd-plan-queue-panel';
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px;width:310px;background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;';
    const button = document.createElement('button');
    button.style.cssText = 'width:100%;padding:8px;background:#00a870;color:#fff;border:0;border-radius:4px;cursor:pointer;';
    const message = document.createElement('div');
    message.style.cssText = 'margin-top:8px;color:#666;white-space:pre-wrap;word-break:break-word;';
    panel.append(button, message);
    document.body.appendChild(panel);
    return { panel, button, message };
  }

  function mountPlanListQueue() {
    const ui = createPlanQueuePanel();
    let saved = loadPlanQueue();
    if (saved && planListScope(saved.returnUrl) !== planListScope(location.href)) saved = null;
    if (saved?.status === 'running') { saved.status = 'paused'; savePlanQueue(saved); }
    const pending = saved && saved.status === 'paused' && saved.cursor < saved.plans.length;
    ui.button.textContent = pending ? '继续执行剩余计划' : '执行当前页开启计划';
    ui.message.textContent = saved ? queueSummary(saved) : '请在过滤筛选属于你的已开启计划';
    if (saved?.results.length) {
      const report = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = '查看逐计划结果';
      report.appendChild(title);
      for (const result of saved.results) {
        const line = document.createElement('div');
        const link = document.createElement('a');
        link.textContent = result.name;
        link.href = result.href;
        link.target = '_blank';
        link.rel = 'noopener';
        line.append(link, document.createTextNode('：' + result.detail));
        report.appendChild(line);
      }
      report.style.cssText = 'margin-top:8px;max-height:220px;overflow:auto;';
      ui.panel.appendChild(report);
    }
    ui.button.addEventListener('click', () => {
      ui.button.disabled = true;
      try {
        if (pending) { saved.status = 'running'; navigatePlanQueue(saved); return; }
        const plans = collectOpenPlans();
        if (!plans.length) { ui.message.textContent = '当前页没有已加载的开启计划。'; return; }
        ui.message.textContent = '当前页共 ' + plans.length + ' 个开启计划，正在进入执行页面…';
        clearRetryState();
        navigatePlanQueue({ version: 1, status: 'running', phase: 'ready', plans, cursor: 0, results: [], returnUrl: location.href });
      } catch (error) {
        ui.message.textContent = '启动失败：' + (error.message || error);
      } finally {
        ui.button.disabled = false;
      }
    });
  }

  function planCaseTotal() {
    const text = document.body.innerText || '';
    const total = text.match(/用例个数\s*[：:]\s*([\d,]+)/);
    if (total) return Number(total[1].replace(/,/g, ''));
    const counts = new Map([...(document.querySelector('#status_counter')?.textContent || '')
      .matchAll(/(不通过|未执行|通过|阻塞)\s*[：:]\s*([\d,]+)/g)]
      .map((match) => [match[1], Number(match[2].replace(/,/g, ''))]));
    return counts.size === 4 ? [...counts.values()].reduce((sum, count) => sum + count, 0) : null;
  }

  async function waitForCompletePlan() {
    const deadline = Date.now() + 60000;
    const expanded = new Set();
    let stable = 0;
    let previous = '';
    while (Date.now() < deadline) {
      if (stopRequested) throw new Error('计划队列已暂停。');
      const total = planCaseTotal();
      const rows = [...document.querySelectorAll('tr.tcase_row')];
      const signature = rows.map((row) => row.getAttribute('item_id')).join(',');
      if (total !== null && rows.length === total) {
        stable = signature === previous ? stable + 1 : 1;
        if (stable >= 3) return rows;
      } else {
        stable = 0;
        const fold = [...document.querySelectorAll('tr.tcase_categories_row #test-plan-row-fold.font-unfold')]
          .find((element) => !expanded.has(element.getAttribute('item_id')) && isAvailable(element));
        if (fold) { expanded.add(fold.getAttribute('item_id')); fold.click(); }
      }
      previous = signature;
      setMessage('正在核对完整列表：已加载 ' + rows.length + '/' + (total ?? '?') + ' 条用例…');
      await sleep(500);
    }
    throw new Error('60 秒内未加载完整用例列表，未执行不完整的计划。');
  }

  async function runQueuedPlan(queue) {
    const plan = currentQueuedPlan(queue);
    if (!plan) return;
    const initialCursor = queue.cursor;
    try {
      setMessage('计划 ' + (queue.cursor + 1) + '/' + queue.plans.length + '：' + plan.name);
      if (queue.phase === 'ready') {
        const latest = readPlanRows(await fetchPlanDocument(plan.sourceUrl), plan.sourceUrl)
          .find((row) => row.id === plan.id && row.workspace === plan.workspace);
        if (!latest) { finishQueuedPlan(queue, 'skipped', '已不在原筛选列表页中，已跳过'); return; }
        if (latest.status !== '开启') { finishQueuedPlan(queue, 'skipped', '当前状态为 ' + (latest.status || '未知') + '，已跳过'); return; }
      }
      const rows = await waitForCompletePlan();
      if (!rows.length && queue.phase === 'submitted') throw new Error('已提交计划的用例列表已清空，无法核对原结果。');
      if (!rows.length) { finishQueuedPlan(queue, 'empty', '已确认该计划没有用例'); return; }
      const ids = rows.map((row) => row.getAttribute('item_id'));
      if (ids.some((id) => !id) || new Set(ids).size !== rows.length) throw new Error('用例标识不完整或重复。');
      if (queue.phase === 'ready') {
        if (ids.every(isRowPassed)) { finishQueuedPlan(queue, 'already-passed', '已全部通过（' + rows.length + ' 条），无需重复执行', rows.length); return; }
        const cfg = getBatchConfig();
        if (!cfg || String(cfg.planId) !== plan.id) throw new Error('批量执行接口的计划 ID 与当前计划不一致，未提交。');
        if (!(await selectAllCases(rows)) || stopRequested) throw new Error('计划队列已暂停。');
        const currentIds = [...document.querySelectorAll('tr.tcase_row')].map((row) => row.getAttribute('item_id'));
        const expected = new Set(ids);
        if (planCaseTotal() !== ids.length || currentIds.length !== ids.length || currentIds.some((id) => !expected.has(id))) {
          throw new Error('提交前用例列表发生变化，未执行。');
        }
        queue.phase = 'submitted';
        queue.itemIds = ids;
        queue.requestConfirmed = false;
        savePlanQueue(queue);
        setMessage('计划 ' + (queue.cursor + 1) + '/' + queue.plans.length + '：' + plan.name
          + '，已全选 ' + ids.length + ' 条，正在一次提交 result_status=pass…');
        if (!(await batchExecuteByApi(ids))) {
          throw new Error('整批提交 pass 未收到成功回执；请检查结果，不会自动重复提交。');
        }
        queue.requestConfirmed = true;
        savePlanQueue(queue);
        // 成功后刷新页面，从服务端重新读取实际结果，避免旧 DOM 假报成功。
        location.reload();
        return;
      }
      // 已提交的计划仅核对结果，刷新或恢复时绝不再发送同一批请求。
      const submittedIds = queue.itemIds;
      if (!Array.isArray(submittedIds) || !submittedIds.length
        || submittedIds.length !== ids.length || submittedIds.some((id) => !ids.includes(id))) {
        throw new Error('队列用例记录与当前计划不一致，需要人工检查。');
      }
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const passed = submittedIds.filter(isRowPassed).length;
        setProgress(passed, submittedIds.length);
        if (passed === submittedIds.length) {
          finishQueuedPlan(queue, 'complete', '已确认全部通过（' + submittedIds.length + ' 条）', submittedIds.length);
          return;
        }
        if (stopRequested) throw new Error('计划队列已暂停；当前已提交请求不能撤回。');
        setMessage('计划 ' + (queue.cursor + 1) + '/' + queue.plans.length + '：' + plan.name
          + '，整批已提交；已确认 ' + passed + '/' + submittedIds.length + ' 条通过。');
        await sleep(300);
      }
      throw new Error('整批提交后 60 秒仍未全部通过，请检查本计划；不会重复提交。');
    } catch (error) {
      if (queue.cursor !== initialCursor) throw error;
      if (stopRequested) {
        queue.status = 'paused';
        savePlanQueue(queue);
        setMessage('已暂停。' + queueSummary(queue) + ' ' + error.message + ' 可返回计划列表继续剩余任务。');
      } else {
        finishQueuedPlan(queue, 'failed', error.message || String(error));
      }
    }
  }

  if (/\/sparrow\/test_plan\/plan_list\/?$/.test(location.pathname)) {
    mountPlanListQueue();
    return;
  }
  if (/\/sparrow\/test_plan\/view\/\d+\/?$/.test(location.pathname) && !document.querySelector('tr.tcase_row')) {
    const queue = loadPlanQueue();
    const plan = currentQueuedPlan(queue);
    if (plan) {
      const ui = createPlanQueuePanel();
      ui.button.textContent = '暂停计划队列';
      let cancelled = false;
      ui.button.addEventListener('click', () => { cancelled = true; queue.status = 'paused'; savePlanQueue(queue); ui.message.textContent = '已暂停，可返回计划列表继续。'; });
      ui.message.textContent = '正在进入 ' + plan.name + ' 的规划&执行页面…';
      (async () => {
        const deadline = Date.now() + 30000;
        while (!cancelled && Date.now() < deadline) {
          const link = [...document.querySelectorAll('a[href]')].map((a) => planLink(a.href, 'detail', plan.id)).find(Boolean);
          if (link) { plan.detailUrl = link; savePlanQueue(queue); location.assign(link); return; }
          await sleep(500);
        }
        if (!cancelled) finishQueuedPlan(queue, 'failed', '未找到规划&执行入口。');
      })().catch((error) => { ui.message.textContent = error.message; });
    }
    return;
  }

  // 更新进度条：已执行/总数
  function setProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `已执行 ${done}/${total} 条`;
  }

  function loadRetryState() {
    try {
      const raw = sessionStorage.getItem(RETRY_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function saveRetryState(state) {
    try {
      sessionStorage.setItem(RETRY_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      // 忽略存储失败
    }
  }

  function clearRetryState() {
    try {
      sessionStorage.removeItem(RETRY_STATE_KEY);
    } catch (error) {
      // 忽略清理失败
    }
  }

  async function waitForRows(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('tr.tcase_row').length > 0) return true;
      await sleep(500);
    }
    return false;
  }

  // 获取某行“最终结果”的 span 元素
  function resultSpan(row) {
    return row.querySelector('.td_status .quick_execute span[rel]');
  }

  // 判断某个 span 是否为“通过”状态
  function isPassSpan(span) {
    if (!span) return false;
    const rel = span.getAttribute('rel');
    if (rel && PASS_STATUS_VALUES.includes(rel)) return true;
    if (PASS_TEXT_REGEX.test(span.textContent || '')) return true;
    if (span.closest('.status_pass') || span.classList.contains('status_pass')) return true;
    return false;
  }

  // 新版 TAPD 的用例名称列没有 field 属性；可由优先级列向前定位。
  function rowTitle(row) {
    const nameCell = row.querySelector('td[field="name"]')
      || row.querySelector('td[field="priority"]')?.previousElementSibling;
    return nameCell?.textContent?.trim() || row.getAttribute('item_id') || '';
  }

  // 检查某行当前是否为“通过”状态（用 item_id 重新查 DOM）
  function isRowPassed(itemId) {
    const row = document.querySelector(`tr.tcase_row[item_id="${CSS.escape(itemId)}"]`);
    if (!row) return false;
    const span = resultSpan(row);
    return isPassSpan(span);
  }

  function targetRows() {
    return [...document.querySelectorAll('tr.tcase_row')].filter((row) => {
      const span = resultSpan(row);
      return span && !isPassSpan(span);
    });
  }

  function rowById(itemId) {
    return document.querySelector(`tr.tcase_row[item_id="${CSS.escape(itemId)}"]`);
  }

  function batchFailure(message) {
    setMessage(`批量执行失败：${message}`);
    console.warn(`[TAPD batch execution] ${message}`);
    return false;
  }

  async function waitForRowsPassed(itemIds, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (itemIds.every((itemId) => isRowPassed(itemId))) return true;
      await sleep(200);
    }
    return false;
  }

  // 读取 TAPD 批量执行所需的接口基址与计划 ID（TFL 配置优先，其次页面内联脚本，最后从 URL 推导）
  function getBatchConfig() {
    try {
      const cfg = window.TFL?.TestPlanDetail?.Tcase?.config;
      if (cfg?.tcase_instance_base_url && cfg?.plan_id) {
        return { base: cfg.tcase_instance_base_url, planId: cfg.plan_id };
      }
    } catch (error) {
      // 忽略，继续降级探测
    }
    try {
      for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        const baseMatch = text.match(/tcase_instance_base_url\s*:\s*"([^"]+)"/);
        const planMatch = text.match(/plan_id\s*:\s*"(\d+)"/);
        if (baseMatch && planMatch) return { base: baseMatch[1], planId: planMatch[1] };
      }
    } catch (error) {
      // 忽略，继续降级探测
    }
    const urlMatch = location.pathname.match(/^\/?(\d+)\/sparrow\/test_plan\/detail\/(\d+)/);
    if (urlMatch) return { base: `/${urlMatch[1]}/sparrow/tcase_instance/`, planId: urlMatch[2] };
    return null;
  }

  // 直接调用 TAPD 批量执行接口（等价于“批量执行用例 → 通过”），不依赖勾选状态或菜单。
  // 返回 Promise<boolean>，true 表示接口确认执行成功。
  function batchExecuteByApi(itemIds) {
    return new Promise((resolve) => {
      try {
        const dollar = window.$ || window.jQuery;
        const cfg = getBatchConfig();
        if (!cfg) {
          console.warn('[TAPD batch execution] 未找到批量执行接口配置');
          resolve(false);
          return;
        }
        const url = cfg.base + 'execute_result/batch_execute/0/';
        const params = new URLSearchParams();
        params.append('data[Result][tcase_id]', itemIds.join(','));
        params.append('data[Result][test_plan_id]', cfg.planId);
        params.append('data[Result][result_status]', 'pass');
        const done = (ok) => resolve(ok);
        if (dollar) {
          dollar.ajax({
            type: 'post',
            url,
            data: params.toString(),
            timeout: 20000,
            success: (response) => done(String(response).trim() === 'true'),
            error: () => done(false),
          });
        } else {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: params.toString(),
            credentials: 'same-origin',
            signal: AbortSignal.timeout(20000),
          })
            .then((response) => response.text())
            .then((text) => done(String(text).trim() === 'true'))
            .catch(() => done(false));
        }
      } catch (error) {
        console.warn('[TAPD batch execution] 调用失败', error);
        resolve(false);
      }
    });
  }

  async function executeBatchRows(rows) {
    const itemIds = rows.map((row) => row.getAttribute('item_id')).filter(Boolean);
    if (itemIds.length !== rows.length) return false;

    // 直连 TAPD 批量执行接口。
    if (!(await batchExecuteByApi(itemIds))) return batchFailure('接口未确认执行成功');

    // 接口成功后可主动重绘这些行，让页面状态与接口一致。
    try {
      const Tcase = window.TFL?.TestPlanDetail?.Tcase;
      if (Tcase && typeof Tcase.reload_tcase_row === 'function') {
        Tcase.reload_tcase_row(itemIds.join(','));
      }
    } catch (error) {
      console.warn('[TAPD batch execution] 刷新行失败', error);
    }

    // 等 DOM 变为“通过”。
    const passed = await waitForRowsPassed(itemIds, 12000);
    if (!passed) return batchFailure('接口已成功但页面状态未更新');
    return passed;
  }

  function isAvailable(element) {
    return element && !element.disabled
      && !element.closest('.disabled, [aria-disabled="true"]');
  }

  function rowCheckbox(row) {
    return row?.querySelector('input[type="checkbox"][name="selected_tcases[]"]');
  }

  // 使用页面的全选事件：包含折叠目录下已加载的用例；实际提交复用批量 pass 接口。
  async function selectAllCases(rows) {
    const selectAll = [...document.querySelectorAll('input[type="checkbox"][name="select_all"]')]
      .find((element) => isAvailable(element) && element.getClientRects().length > 0);
    if (!selectAll) throw new Error('未找到可用的“全选当前已加载数据”复选框。');
    if (rows.some((row) => !isAvailable(rowCheckbox(row)))) {
      throw new Error('部分用例缺少可用的复选框，请检查执行权限。');
    }
    if (selectAll.checked && rows.some((row) => !rowCheckbox(row).checked)) selectAll.click();
    if (!selectAll.checked) selectAll.click();
    const itemIds = rows.map((row) => row.getAttribute('item_id'));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (stopRequested) return false;
      if (itemIds.every((itemId) => rowCheckbox(rowById(itemId))?.checked)) return true;
      await sleep(100);
    }
    throw new Error('全选未覆盖全部已加载用例，已停止提交。');
  }

  async function executeBatch() {
    const initialRows = targetRows();
    if (initialRows.length === 0) {
      clearRetryState();
      setMessage('没有检测到非通过用例。');
      resetButton();
      return;
    }

    const retryState = loadRetryState();
    stopRequested = false;
    button.disabled = true;
    batchButton.textContent = '暂停执行';
    batchButton.style.background = '#d32f2f';
    startKeepAlive();
    requestWakeLock();

    let succeeded = 0;
    const failed = [];
    const skippedIds = new Set();
    const skippedRows = new Set();
    setProgress(0, initialRows.length);
    while (!stopRequested) {
      const rows = targetRows()
        .filter((row) => !skippedIds.has(row.getAttribute('item_id')) && !skippedRows.has(row))
        .slice(0, BATCH_SIZE);
      if (rows.length === 0) break;

      const titles = rows.map(rowTitle);
      setMessage(`正在批量处理 ${titles.length} 条：${titles[0]}${titles.length > 1 ? ` 等 ${titles.length} 条` : ''}`);
      if (await executeBatchRows(rows)) {
        succeeded += rows.length;
      } else {
        failed.push(...titles);
        rows.forEach((row) => {
          const itemId = row.getAttribute('item_id');
          if (itemId) skippedIds.add(itemId);
          else skippedRows.add(row);
        });
        setMessage(`本批次 ${titles.length} 条执行失败，已跳过，继续处理剩余用例。`);
      }
      setProgress(succeeded + failed.length, initialRows.length);
      await sleep(BETWEEN_CASES_MS);
    }

    stopKeepAlive();
    releaseWakeLock();
    if (stopRequested) {
      clearRetryState();
      resetButton();
      setMessage(`已停止：成功 ${succeeded} 条，失败 ${failed.length} 条。`);
      return;
    }

    if (failed.length > 0) {
      if (retryState?.afterRefresh) {
        clearRetryState();
        resetButton();
        setMessage(`刷新后执行仍失败，已停止。成功 ${succeeded} 条，失败 ${failed.length} 条。`);
        return;
      }

      const attempt = retryState?.attempt || 1;
      if (attempt < MAX_ATTEMPTS) {
        saveRetryState({ attempt: attempt + 1, afterRefresh: false, mode: 'batch' });
        scheduleRetry('batch');
        setMessage(`本次 ${failed.length} 条失败，${RETRY_DELAY_MS / 1000} 秒后自动重试（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）。`);
      } else {
        saveRetryState({ attempt: 1, afterRefresh: true, mode: 'batch' });
        setMessage('连续 3 次执行仍有失败，正在刷新页面后重试...');
        location.reload();
      }
      return;
    }

    clearRetryState();
    resetButton();
    setMessage(`批量执行完成：成功 ${succeeded} 条，失败 ${failed.length} 条。`);
  }

  let stopRequested = false;
  let keepAlive = null;
  let wakeLock = null;

  // 播放一段人耳几乎听不到的循环音，让 Chrome 不把当前标签页当作
  // “静默后台标签页”而做高强度定时器节流，避免执行看起来像卡住。
  function startKeepAlive() {
    if (keepAlive) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = Math.sin((i * 2 * Math.PI * 440) / ctx.sampleRate) * 0.001;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(ctx.destination);
      source.start();
      keepAlive = { ctx, source };
    } catch (error) {
      keepAlive = null;
    }
  }

  function stopKeepAlive() {
    if (!keepAlive) return;
    try {
      keepAlive.source.stop();
      keepAlive.ctx.close();
    } catch (error) {
      // 忽略关闭时的异常
    }
    keepAlive = null;
  }

  // 屏幕唤醒锁：阻止电脑进入休眠。需要用户手势触发，且页面隐藏时
  // 浏览器会自动释放，因此与 keepAlive 配合使用。
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (error) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      wakeLock.release();
    } catch (error) {
      // 忽略释放时的异常
    }
    wakeLock = null;
  }

  async function executeOneClick() {
    const rows = [...document.querySelectorAll('tr.tcase_row')];
    if (!rows.length) {
      clearRetryState();
      setMessage('没有检测到已加载的测试用例。');
      resetButton();
      return;
    }
    clearRetryState();
    stopRequested = false;
    button.textContent = '取消提交';
    button.style.background = '#d32f2f';
    batchButton.disabled = true;
    startKeepAlive();
    requestWakeLock();
    setProgress(0, rows.length);
    try {
      const ids = rows.map((row) => row.getAttribute('item_id'));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('用例标识不完整或重复。');
      const planId = location.pathname.match(/\/sparrow\/test_plan\/detail\/(\d+)/)?.[1];
      const cfg = getBatchConfig();
      if (!cfg || String(cfg.planId) !== planId) throw new Error('接口计划 ID 与当前计划不一致，未提交。');
      const total = planCaseTotal();
      if (total !== null && total !== rows.length) throw new Error('已加载用例数与计划总数不一致，未提交。');
      setMessage('正在全选当前计划的 ' + ids.length + ' 条用例…');
      if (!(await selectAllCases(rows)) || stopRequested) { setMessage('已取消，尚未提交。'); return; }
      const currentIds = [...document.querySelectorAll('tr.tcase_row')].map((row) => row.getAttribute('item_id'));
      const expected = new Set(ids);
      if (currentIds.length !== ids.length || currentIds.some((id) => !expected.has(id))) {
        throw new Error('全选期间用例列表发生变化，未提交。');
      }
      button.textContent = '正在提交 pass…';
      button.disabled = true;
      setMessage('已全选 ' + ids.length + ' 条，正在一次提交 result_status=pass…');
      if (!(await batchExecuteByApi(ids))) throw new Error('整批 pass 请求未收到成功回执；不会自动重复提交。');
      try {
        const tcase = window.TFL?.TestPlanDetail?.Tcase;
        if (typeof tcase?.reload_tcase_row === 'function') tcase.reload_tcase_row(ids.join(','));
        window.TFL?.TestPlanDetail?.update_counter?.();
      } catch (error) { console.warn('[TAPD one-click execution] 页面刷新失败', error); }
      if (await waitForRowsPassed(ids, 30000)) {
        setProgress(ids.length, ids.length);
        setMessage('整批提交成功，已确认 ' + ids.length + ' 条全部通过。');
      } else {
        setProgress(ids.filter(isRowPassed).length, ids.length);
        setMessage('接口已确认整批 pass，但页面未在 30 秒内全部显示通过。请刷新核对；不会自动重复提交。');
      }
    } catch (error) {
      setMessage('一键执行失败：' + (error.message || error));
      console.warn('[TAPD one-click execution]', error);
    } finally { resetButton(); }
  }

  let retryTimer = null;
  let retryCountdown = RETRY_DELAY_MS / 1000;

  function scheduleRetry(mode = 'batch') {
    stopRequested = false;
    retryCountdown = RETRY_DELAY_MS / 1000;
    const retryButton = mode === 'batch' ? batchButton : button;
    retryButton.textContent = `${retryCountdown}s 后自动重试`;
    retryButton.style.background = '#d32f2f';
    retryTimer = setInterval(() => {
      retryCountdown -= 1;
      if (retryCountdown <= 0) {
        clearInterval(retryTimer);
        retryTimer = null;
        isRunning = true;
        const run = mode === 'batch' ? executeBatch : executeOneClick;
        run().finally(() => {
          isRunning = false;
        });
        return;
      }
      retryButton.textContent = `${retryCountdown}s 后自动重试`;
    }, 1000);
  }

  function cancelRetry() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    clearRetryState();
    resetButton();
    setMessage('已取消自动重试。');
  }

  function resetButton() {
    button.textContent = '一键执行用例';
    button.style.background = '#00a870';
    button.removeAttribute('disabled');
    batchButton.textContent = '批量执行用例';
    batchButton.style.background = '#1677ff';
    batchButton.removeAttribute('disabled');
    stopKeepAlive();
    releaseWakeLock();
  }

  let isRunning = false;
  let autoResumeRunning = false;
  function handleClick() {
    if (autoResumeRunning) return;
    if (retryTimer) {
      cancelRetry();
      return;
    }
    if (isRunning) {
      stopRequested = true;
    } else {
      isRunning = true;
      executeOneClick().finally(() => {
        isRunning = false;
      });
    }
  }

  // 页面重新回到前台时，若仍在执行则重新请求唤醒锁。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isRunning && !wakeLock) requestWakeLock();
  });

  const panel = document.createElement('div');
  panel.id = 'tapd-exec-panel';
  panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px;width:280px;background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;';
  const button = document.createElement('button');
  button.textContent = '一键执行用例';
  button.style.cssText = 'width:100%;padding:8px;background:#00a870;color:#fff;border:0;border-radius:4px;cursor:pointer;';
  button.addEventListener('click', handleClick);
  const batchButton = document.createElement('button');
  batchButton.textContent = '批量执行用例';
  batchButton.style.cssText = 'width:100%;margin-top:6px;padding:8px;background:#1677ff;color:#fff;border:0;border-radius:4px;cursor:pointer;';
  batchButton.addEventListener('click', () => {
    if (autoResumeRunning) return;
    if (retryTimer) {
      cancelRetry();
      return;
    }
    if (isRunning) {
      stopRequested = true;
      return;
    }
    isRunning = true;
    executeBatch().finally(() => {
      isRunning = false;
    });
  });
  const message = document.createElement('div');
  message.style.cssText = 'margin-top:8px;color:#666;word-break:break-word;';
  const setMessage = (text) => { message.textContent = text; };
  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'margin-top:8px;';
  const progressBar = document.createElement('div');
  progressBar.style.cssText = 'height:8px;background:#eee;border-radius:4px;overflow:hidden;';
  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'width:0%;height:100%;background:#1677ff;border-radius:4px;transition:width .3s;';
  const progressText = document.createElement('div');
  progressText.style.cssText = 'margin-top:2px;color:#666;font-size:12px;';
  progressBar.appendChild(progressFill);
  progressWrap.append(progressBar, progressText);
  const pendingCount = targetRows().length;
  setMessage(`已检测到 ${pendingCount} 条非通过用例。`);
  setProgress(0, pendingCount);
  panel.append(button, batchButton, message, progressWrap);
  document.body.appendChild(panel);

  // 计划队列只在当前目标计划中恢复，其他已打开的页签不会参与。
  const planQueue = loadPlanQueue();
  if (currentQueuedPlan(planQueue)) {
    clearRetryState();
    isRunning = true;
    autoResumeRunning = true;
    stopRequested = false;
    button.disabled = true;
    batchButton.disabled = true;
    const pauseQueue = document.createElement('button');
    pauseQueue.textContent = '暂停计划队列';
    pauseQueue.style.cssText = batchButton.style.cssText;
    pauseQueue.style.background = '#d32f2f';
    pauseQueue.addEventListener('click', () => {
      stopRequested = true;
      planQueue.status = 'paused';
      savePlanQueue(planQueue);
      pauseQueue.disabled = true;
      setMessage('正在暂停计划队列；已经提交的请求不能撤回。');
    });
    panel.appendChild(pauseQueue);
    startKeepAlive();
    requestWakeLock();
    runQueuedPlan(planQueue).catch((error) => {
      planQueue.status = 'paused';
      try { savePlanQueue(planQueue); } catch (storageError) { /* 保留页面错误提示。 */ }
      setMessage('计划队列已暂停：' + (error.message || error));
    }).finally(() => {
      isRunning = false;
      autoResumeRunning = false;
      pauseQueue.disabled = true;
      resetButton();
    });
    return;
  }

  // 刷新页面后自动恢复批量执行：等待用例列表出现，然后直接开始。
  const initialRetryState = loadRetryState();
  if (initialRetryState?.afterRefresh && initialRetryState.mode === 'batch') {
    autoResumeRunning = true;
    setMessage('页面已刷新，正在等待用例列表加载后自动执行...');
    (async () => {
      const ready = await waitForRows();
      autoResumeRunning = false;
      if (!ready) {
        clearRetryState();
        setMessage('刷新后未检测到用例列表，已停止。');
        return;
      }
      isRunning = true;
      await executeBatch();
      isRunning = false;
    })();
  } else if (initialRetryState) {
    clearRetryState();
  }
})();
