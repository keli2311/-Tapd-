# TAPD 非通过用例批量改为通过

脚本：[tapd_pending_to_pass.user.js](./tapd_pending_to_pass.user.js)。适用于所有 TAPD 测试计划详情页：

https://tapd.tencent.com/*/sparrow/test_plan/detail/*

脚本识别“最终结果”不是“通过”的用例，先自动展开这些用例所在的列表，再逐条点击“最终结果”单元格，在展开的选项框中选择“通过”。每条用例确认页面结果已变为“通过”后才继续。

## 使用方式

1. 在 Chrome 中安装 Tampermonkey 扩展，新建脚本。
2. 粘贴 	apd_pending_to_pass.user.js 的全部内容并保存。
3. 打开任意 TAPD 测试计划详情页（/sparrow/test_plan/detail/*）；右下角会显示待处理数量。
4. 点击“将非通过结果改为通过”，并在浏览器确认框中确认写入。

## 技术要点

- 识别非通过用例的依据：span[rel] 的 
el 属性值（status_pass / pass 视为通过，其余为非通过）。
- 展开折叠列表：自动找到用例行所属的分类目录行，依次展开后再执行修改。
- 逐条执行：每条先点击状态单元格，等待选项框出现，选中“通过”，再用 item_id 重新查询 DOM 确认状态变更后才继续下一条。
- 兼容性：@match 覆盖所有 */sparrow/test_plan/detail/* 路径，不限定具体项目 ID 或迭代。
- 超时处理：每条等待最多 3 秒，超时的用例在最终提示中列出。