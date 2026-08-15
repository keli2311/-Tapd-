// ==UserScript==
// @name         TAPD 测试计划：非通过用例批量改为通过
// @namespace    local.tapd.automation
// @version      2.0.12
// @description  展开用例列表后，通过“最终结果”下拉框将非通过用例逐条设为通过（适用于所有测试计划详情页）。
// @match        https://tapd.tencent.com/*/sparrow/test_plan/detail/*
// @match        https://tapd.woa.com/*/sparrow/test_plan/view/*
// @match        http://localhost:8080/*
// @downloadURL  https://raw.githubusercontent.com/keli2311/-Tapd-/main/tapd_pending_to_pass.user.js
// @updateURL    https://raw.githubusercontent.com/keli2311/-Tapd-/main/tapd_pending_to_pass.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const PASS_STATUS_VALUES = ['status_pass', 'pass'];
  const PASS_TEXT_REGEX = /^\s*通过\s*$/;
  const MENU_WAIT_MS = 180;
  const BETWEEN_CASES_MS = 350;
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 10000;
  const RETRY_STATE_KEY = 'tapdExecRetryState';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function categoryChain(row) {
    const categories = [];
    let current = row;
    while (current?.getAttribute('parent')) {
      const parentId = current.getAttribute('parent');
      current = document.querySelector(`tr.tcase_categories_row[item_id="${CSS.escape(parentId)}"]`);
      if (!current) break;
      categories.unshift(current);
    }
    return categories;
  }

  async function expandTargetLists(rows) {
    const categories = new Set(rows.flatMap(categoryChain));
    for (const category of categories) {
      const fold = category.querySelector('#test-plan-row-fold.font-unfold');
      if (fold) {
        fold.click();
        await sleep(MENU_WAIT_MS);
      }
    }
  }

  function passMenuOption() {
    return [...document.querySelectorAll('a, button, [role="menuitem"], li, span')].find((element) => {
      if (element.offsetParent === null || !PASS_TEXT_REGEX.test(element.textContent || '')) return false;
      if (element.closest('tr.tcase_row') || element.closest('#status_counter')) return false;
      if (element.closest('[data-handle="batch_quick_execute"]')) return false;
      return element.matches('[data-result-status="pass"], [data-result="pass"], [rel="status_pass"], .status_pass, a, button, [role="menuitem"], li');
    });
  }

  // 等待指定 item_id 的用例变为“通过”
  async function waitForPass(itemId, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isRowPassed(itemId)) return true;
      await sleep(200);
    }
    return false;
  }

  async function setResultToPass(row) {
    const statusSpan = resultSpan(row);
    if (!statusSpan) return false;

    const itemId = row.getAttribute('item_id');
    if (!itemId) return false;

    statusSpan.click();
    await sleep(MENU_WAIT_MS);

    const option = passMenuOption();
    if (!option) return false;

    option.click();
    return await waitForPass(itemId);
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

  async function execute() {
    const rows = targetRows();
    if (rows.length === 0) {
      clearRetryState();
      setMessage('没有检测到非通过用例。');
      resetButton();
      return;
    }

    const retryState = loadRetryState();
    stopRequested = false;
    button.textContent = '暂停';
    button.style.background = '#d32f2f';
    startKeepAlive();
    requestWakeLock();
    await expandTargetLists(rows);
    let succeeded = 0;
    const failed = [];

    for (let index = 0; index < rows.length; index += 1) {
      if (stopRequested) {
        clearRetryState();
        setMessage(`已停止：已完成 ${index}/${rows.length} 条（成功 ${succeeded} 条）。`);
        resetButton();
        return;
      }
      const row = rows[index];
      const title = row.querySelector('td[field="name"]')?.textContent?.trim() || row.getAttribute('item_id');
      setMessage(`正在处理 ${index + 1}/${rows.length}：${title}`);
      if (await setResultToPass(row)) succeeded += 1;
      else failed.push(title);
      await sleep(BETWEEN_CASES_MS);
    }

    stopKeepAlive();
    releaseWakeLock();

    if (failed.length === 0) {
      clearRetryState();
      resetButton();
      setMessage(`完成：成功 ${succeeded} 条，失败 0 条。`);
      return;
    }

    // 刷新页面后的执行仍失败：停止。
    if (retryState?.afterRefresh) {
      clearRetryState();
      resetButton();
      setMessage(`刷新后执行仍失败，已停止。成功 ${succeeded} 条，失败 ${failed.length} 条。`);
      return;
    }

    const attempt = retryState?.attempt || 1;
    if (attempt < MAX_ATTEMPTS) {
      saveRetryState({ attempt: attempt + 1, afterRefresh: false });
      scheduleRetry();
      setMessage(`本次 ${failed.length} 条失败，${RETRY_DELAY_MS / 1000} 秒后自动重试（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）。`);
    } else {
      saveRetryState({ attempt: 1, afterRefresh: true });
      setMessage('连续 3 次执行仍有失败，正在刷新页面后重试...');
      location.reload();
    }
  }

  let retryTimer = null;
  let retryCountdown = RETRY_DELAY_MS / 1000;

  function scheduleRetry() {
    stopRequested = false;
    retryCountdown = RETRY_DELAY_MS / 1000;
    button.textContent = `${retryCountdown}s 后自动重试`;
    button.style.background = '#d32f2f';
    retryTimer = setInterval(() => {
      retryCountdown -= 1;
      if (retryCountdown <= 0) {
        clearInterval(retryTimer);
        retryTimer = null;
        isRunning = true;
        execute().finally(() => {
          isRunning = false;
        });
        return;
      }
      button.textContent = `${retryCountdown}s 后自动重试`;
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
    button.textContent = '开始执行用例';
    button.style.background = '#00a870';
    button.removeAttribute('disabled');
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
      execute().finally(() => {
        isRunning = false;
      });
    }
  }

  // 页面重新回到前台时，若仍在执行则重新请求唤醒锁。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isRunning && !wakeLock) requestWakeLock();
  });

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px;width:280px;background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;';
  const button = document.createElement('button');
  button.textContent = '开始执行用例';
  button.style.cssText = 'width:100%;padding:8px;background:#00a870;color:#fff;border:0;border-radius:4px;cursor:pointer;';
  button.addEventListener('click', handleClick);
  const message = document.createElement('div');
  message.style.cssText = 'margin-top:8px;color:#666;word-break:break-word;';
  const setMessage = (text) => { message.textContent = text; };
  setMessage(`已检测到 ${targetRows().length} 条非通过用例。`);
  panel.append(button, message);
  document.body.appendChild(panel);

  // 刷新页面后自动恢复执行：等待用例列表出现，然后直接开始。
  const initialRetryState = loadRetryState();
  if (initialRetryState?.afterRefresh) {
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
      await execute();
      isRunning = false;
    })();
  }
})();
