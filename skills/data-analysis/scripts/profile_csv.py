import csv
import sys
from collections import Counter
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python profile_csv.py <file.csv>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        print("没有数据行")
        return 1
    print(f"行数 {len(rows)}")
    for column in rows[0]:
        values = [row.get(column, "") for row in rows]
        blank = sum(value == "" for value in values)
        numbers: list[float] = []
        for value in values:
            try:
                numbers.append(float(value))
            except ValueError:
                pass
        if numbers and len(numbers) == len(values) - blank:
            print(
                f"{column}: 数值 {len(numbers)} 空 {blank} 最小 {min(numbers)} 最大 {max(numbers)} 合计 {sum(numbers)}"
            )
        else:
            common = Counter(value for value in values if value).most_common(3)
            print(f"{column}: 文本 空 {blank} 常见 {common}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
