# 可用架数预测：晚到维修工单场景的本地实现

仅使用 Node.js 内置模块（`http`/`fs`/`crypto` 等），无第三方依赖。

## 运行

```bash
node server.js          # 实际入口为 src/server.js，也可用 npm start
# 或
PORT=9090 node src/server.js
```

服务读取 `PORT`（默认 8080），只绑定 `127.0.0.1`，打开 http://127.0.0.1:8080/ 。

## 测试

```bash
node --test
```

30 个用例，覆盖正常路径与异常路径（数据不足、非法 episode、未知路由、非法 JSON）。

## 页面三个操作（结果均由后端实时计算）

1. **生成原能力预测** —— 生成确定性合成数据（固定随机种子，可复现）：12 架机、
   4 类故障（维修时长 3/5/8/12 天）、约 30% 工单晚录入，其中 1 张在基准日完全未录入，
   另有 4 个锚点片段保证基准日有一批「仍未修好」的架。
2. **补录早期停用** —— 把基准日前已物理停用但未录入的工单补录（`recordedDate=基准日`，
   `groundDate` 不变），重算修订版与台账，晚到缺口清零、转入系统待修。
3. **查看回测和区间** —— 未来 5 天 P10/P50/P90 可用架数区间（400 次蒙特卡洛），
   两种估算器的历史回放对比，以及未修好批次对区间宽度的贡献。

业务结果区带 `data-evidence-result` 属性，取值随操作变化
（`empty` / `generated` / `backfilled` / `backtest` / `error`），便于核对操作前后内容。

## 关键设计

| 题目概念 | 实现 |
| --- | --- |
| 待修 / 归还 / 实际可用对齐 | `src/ledger.js`：按 `groundDate`/`closedDate` 物理事件统计，`recordedDate` 只决定系统可见性，二者差为晚到缺口 |
| 工单晚到但架已停用 | episode 的 `recordedDate > groundDate`；`hidden=true` 表示基准日完全未录入 |
| 基线估算器给区间 | `src/forecast.js`：泊松到达 + 经验时长重采样的蒙特卡洛，输出 P10/P50/P90 |
| 方案比较端读同一修订版 | `src/revision.js`：基准日可见数据的不可变快照，内容哈希生成 `revisionId`；回测断言两方法 revisionId 相同 |
| 固定平均 vs 分类型估算 | `src/estimators.js`：fixed 从全局经验池抽样（类型构成漂移即有偏），byType 按类型抽样 |
| 历史回放比较偏差 | `src/backtest.js`：7 个历史基准日 + 1 个过早基准日，指标 MAE/偏差/P10–P90 覆盖率/区间宽 |
| 未修好批次如何影响范围 | 同一批未来情景下对比 stochastic（剩余时长随机）与 point（取均值）两种模式的区间宽度差 |

## 目录

```
src/
  dates.js          日期/分位数工具
  rng.js            确定性 PRNG、泊松/高斯采样
  errors.js         业务错误码
  synthetic-data.js 合成数据与补录
  revision.js       修订版快照与哈希
  ledger.js         每日台账对齐
  estimators.js     fixed / byType 两种估算器
  forecast.js       区间预测与未修好批次影响
  backtest.js       历史回放
  server.js         HTTP 服务与页面
public/index.html   前端
test/               node --test 用例
```
