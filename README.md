# TAPD 非通过用例批量改为通过

脚本：[tapd_pending_to_pass.user.js](./tapd_pending_to_pass.user.js)。适用于：

`https://tapd.tencent.com/DFM_TEST/sparrow/test_plan/detail/1020428366000790099?view_type=list`

脚本识别“最终结果”不是“通过”的用例，先展开这些用例所在的列表，再逐条点击“最终结果”单元格，在展开的选项框中选择“通过”。每条用例确认页面结果已变为“通过”后才继续。

## 使用方式

1. 在 Chrome 中安装 Tampermonkey，并新建脚本。
2. 粘贴 `tapd_pending_to_pass.user.js` 的全部内容并保存。
3. 打开上述 TAPD 测试计划页面；右下角会显示待处理数量。
4. 点击“将非通过结果改为通过”，并在确认框中确认写入。

本次按该页面实际结构验证到一条“不通过”用例，其最终结果元素为 `.td_status .quick_execute span[rel="status_no_pass"]`；“通过”用例使用 `rel="status_pass"`。
