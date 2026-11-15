# Wine list generator

`data/wines.csv` (bottle list, 375 wines) and `data/glass.csv` (by the glass, 38 wines) are the source of truth.
`main.typ` lays them out; sections, sub-regions, "… continued" headings, hanging • markers, old-style vintages,
small-caps NV, price columns and page breaks are all automatic.

    pip install typst
    python3 build.py          # -> wine-list.pdf   (or: typst compile main.typ)

Edit a price or add a row in the CSV, rebuild, done. Row order in the CSV is print order.

**Fonts:** the original uses Wolpe Pegasus + Helvetica Neue (licensed). Drop the font files into `fonts/` and the
build uses them automatically; until then it falls back to Libertinus Serif + Liberation Sans.

`tools/` holds the scripts that extracted the CSVs from the printed PDF (one-off; not needed to rebuild).
See `CHECK-THESE.md` for data problems found during extraction.
