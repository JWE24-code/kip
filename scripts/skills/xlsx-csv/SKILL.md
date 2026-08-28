---
name: xlsx-csv
description: Read and summarize a spreadsheet (.xlsx, .xls or .csv) that lives in the coop.
when_to_use: >
  The question is about tabular data in a file — a CSV or spreadsheet path, column
  totals or averages, row counts, "what's in eggs/data.csv", "summarize the budget sheet".
entry: run.js
network: false
timeout: 30
parameters:
  - { name: file, type: string, required: true, description: "Path to the .xlsx/.xls/.csv, relative to the coop root (or absolute)." }
  - { name: operation, type: string, required: false, enum: [summarize, head], default: summarize, description: "summarize = columns + row count + per-column stats + first rows; head = just the first rows." }
  - { name: sheet, type: string, required: false, description: "Sheet name for a multi-sheet workbook (default: first sheet)." }
  - { name: maxRows, type: number, required: false, description: "Rows to show for operation=head (default 20)." }
---
Call this with the coop-relative path to a spreadsheet. Start with
`operation: "summarize"` — it gives you the column names, row count, per-column
type, numeric min/max/sum/mean, and the first few rows as a markdown table.
Use `operation: "head"` when you need specific cell values. The output is
markdown you can quote directly in your answer.
