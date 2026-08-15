﻿ # TAPD 非通过用例批量改为通过
 
 脚本：[tapd_pending_to_pass.user.js](./tapd_pending_to_pass.user.js)。适用于所有 TAPD 测试计划详情页：
 
 https://tapd.tencent.com/*/sparrow/test_plan/detail/*
 
 脚本识别"最终结果"不是"通过"的用例，支持两种执行方式：逐条点击"最终结果"单元格，或每批勾选 10 条用例后直接调用 TAPD 的批量执行接口改为"通过"。每批都会确认页面结果已变为"通过"后才继续。
 
 ## 使用方式
 
 1. 在 Chrome 中安装 Tampermonkey 扩展，新建脚本。
 2. 粘贴 tapd_pending_to_pass.user.js 的全部内容并保存。
 3. 打开任意 TAPD 测试计划详情页（/sparrow/test_plan/detail/*）；右下角会显示待处理数量。
4. 点击“逐条执行用例”逐条执行，或点击“批量执行用例”按每批 10 条执行。
 
 ## 技术要点
 
 - 识别非通过用例的依据：span[rel] 的 rel 属性值（status_pass / pass 视为通过，其余为非通过）。
 - 展开折叠列表：自动找到用例行所属的分类目录行，依次展开后再执行修改。
 - 逐条执行：每条先点击状态单元格，等待选项框出现，选中"通过"，再用 item_id 重新查询 DOM 确认状态变更后才继续下一条。
- 批量执行：每批勾选最多 10 条非通过用例，直接调用 TAPD 自身的批量执行接口（TFL.TestPlanDetail.Tcase.batch_quick_execute → execute_result/batch_execute/0/），不再操作行菜单，避免 TAPD 菜单依赖真实鼠标渲染导致点击无效的问题；每批等待结果变为"通过"后再处理下一批。
- 兼容性：@match 覆盖 https://tapd.tencent.com/*/sparrow/test_plan/detail/* 与 https://tapd.woa.com/*/sparrow/test_plan/view/*，不限定具体项目 ID 或迭代。
 - 超时处理：每条等待最多 3 秒，超时的用例在最终提示中列出。
 - 保持活跃：执行期间播放人耳几乎听不到的循环音（阻止浏览器高强度节流）并请求屏幕唤醒锁（阻止系统休眠）；暂停或完成后自动释放。
- 失败重试：有失败用例时 3 秒后自动重试（可点击取消）；连续 3 次仍失败则自动刷新页面并继续，刷新后仍失败则停止。状态通过 sessionStorage 跨刷新保留。
## 自动更新

脚本头部包含 @downloadURL 和 @updateURL，指向 GitHub 仓库：

- https://raw.githubusercontent.com/keli2311/-Tapd-/main/tapd_pending_to_pass.user.js

安装了 Tampermonkey 后，脚本会定期自动检查更新并提示升级。

## 更新日志

| 版本 | 变更 |
|------|------|
| 2.2.3 | 批量执行从开始到结束都不展开任何层级（仅批量模式；逐条模式仍保持展开后执行） |
| 2.2.2 | 统一逐条/批量执行中的暂停按钮文案为“暂停执行”；批量每批处理前展开目标层级，与逐条一致 |
| 2.2.1 | “开始执行用例”按钮更名为“逐条执行用例” |
| 2.2.0 | 批量执行改为直连 TAPD 接口（绕开行菜单渲染/点击链路），移除菜单模拟；失败时清理勾选 |
| 2.1.3 | 重构批量执行：强制显示子菜单绕过 CSS :hover、只定位打开的菜单、通用确认按钮匹配、失败后清理勾选与菜单 |
| 2.1.2 | 修复 TAPD 重绘后继续点击旧菜单节点导致批量执行无效的问题 |
| 2.1.1 | 放宽批量菜单定位，按 data-handle 和文字查找，并等待 TAPD 异步重绘完成 |
| 2.1.0 | 新增“批量执行用例”按钮，每批选择 10 条非通过用例并批量改为通过 |
| 2.0.13 | 失败用例的自动重试等待时间由 10 秒缩短为 3 秒 |
| 2.0.12 | 失败自动重试：10 秒后重新执行，最多 3 次仍失败则刷新页面后执行，刷新后仍失败则停止 |
| 2.0.11 | 执行时播放低音量循环音并请求屏幕唤醒锁，防止后台节流和系统休眠中断执行 |
| 2.0.10 | 执行中的按钮文本改为"暂停" |
| 2.0.9 | 按钮改为"开始执行用例"，执行中变红色可点击停止，再次点击重新开始 |
| 2.0.8 | 恢复 @match tapd.woa.com/view/* |
| 2.0.7 | 移除 @match tapd.woa.com/*/sparrow/test_plan/view/*，仅保留 tencent.com/detail/* |
| 2.0.6 | 新增 @downloadURL / @updateURL，支持 Tampermonkey 自动更新 |
| 2.0.4 | 新增 @match https://tapd.woa.com/*/sparrow/test_plan/view/* |
| 2.0.3 | 状态判断改用 PASS_STATUS_VALUES 数组；新增 isPassSpan / isRowPassed；waitForPass 改用 itemId 查询；@match 改为通用路径 |
| 2.0.0 | 重写为点击"最终结果"单元格 → 选项框选择"通过"的方式 |
| 1.0.0 | 初始版本，通过快速执行按钮操作 |
