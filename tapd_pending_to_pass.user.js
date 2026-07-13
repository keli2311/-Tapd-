// ==UserScript==
// @name         TAPD 测试计划：非通过用例批量改为通过
// @namespace    local.tapd.automation
// @version      2.0.6
// @description  展开用例列表后，通过“最终结果”下拉框将非通过用例逐条设为通过（适用于所有测试计划详情页）。
// @match        https://tapd.tencent.com/*/sparrow/test_plan/detail/*
// @match        https://tapd.woa.com/*/sparrow/test_plan/view/*
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async function run() {
    const rows = targetRows();
    if (rows.length === 0) {
      setMessage('没有检测到非通过用例。');
      return;
    }
    if (!window.confirm(`将 ${rows.length} 条非通过用例的“最终结果”改为“通过”。该操作会写入 TAPD，是否继续？`)) return;

    button.disabled = true;
    await expandTargetLists(rows);
    let succeeded = 0;
    const failed = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const title = row.querySelector('td[field="name"]')?.textContent?.trim() || row.getAttribute('item_id');
      setMessage(`正在处理 ${index + 1}/${rows.length}：${title}`);
      if (await setResultToPass(row)) succeeded += 1;
      else failed.push(title);
      await sleep(BETWEEN_CASES_MS);
    }

    button.disabled = false;
    setMessage(`完成：成功 ${succeeded} 条，失败 ${failed.length} 条。${failed.length ? `失败项：${failed.join('；')}` : ''}`);
  }

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px;width:280px;background:#fff;border:1px solid #d9d9d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;';
  const button = document.createElement('button');
  button.textContent = '将非通过结果改为通过';
  button.style.cssText = 'width:100%;padding:8px;background:#00a870;color:#fff;border:0;border-radius:4px;cursor:pointer;';
  button.addEventListener('click', run);
  const message = document.createElement('div');
  message.style.cssText = 'margin-top:8px;color:#666;word-break:break-word;';
  const setMessage = (text) => { message.textContent = text; };
  setMessage(`已检测到 ${targetRows().length} 条非通过用例。`);
  panel.append(button, message);
  document.body.appendChild(panel);
})();