---
name: data-analysis
description: 汇总 CSV 或表格的行数、空值和合计。在用户给出表格、CSV 或一组数字时使用。
metadata:
  display-name: 数据分析
allowed-tools: read_file run_shell
---

先确认列名和单位。需要计算时读取 references/metrics.md，再用现有 run_shell 执行 scripts/profile_csv.py。不要安装依赖，也不要跳过审批。
