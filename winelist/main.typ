// Toklas wine list — generated from data/wines.csv and data/glass.csv
// Build:  typst compile main.typ wine-list.pdf        (or: python3 build.py)
// Put licensed fonts (Wolpe Pegasus, Helvetica Neue) in ./fonts and they are picked up automatically;
// until then the fallbacks below are used.

#let serif = ("Wolpe Pegasus", "Libertinus Serif")
#let sans = ("Helvetica Neue", "Liberation Sans")
#let ink = rgb("#1a1a1a")

#let wines = csv("data/wines.csv", row-type: dictionary)
#let glass = csv("data/glass.csv", row-type: dictionary)
#let intro = read("data/intro.txt")

#let set-part(name) = [#metadata(name) <partmark>]
#let cols-bottle = (175pt, 130pt, 30pt)
#let cols-glass = (175pt, 105pt, 18pt, 18pt, 18pt)

// ---------- small typographic helpers ----------
#let onum(body) = text(features: ("onum",), body)
#let abv(v) = if v != "" { text(font: sans, size: 7.1pt)[#v%] }
#let price(v) = text(font: sans, size: 7.4pt, v)
#let hang(flag) = if flag == "Y" { place(left, dx: -11pt, dy: 0.5pt, text(font: sans, size: 9pt)[•]) }
#let vintage(v) = if v == "NV" { smallcaps[NV] } else { onum(v) }

#let region-line(r) = {
  [#r.region, #r.country #vintage(r.vintage)]
  if r.abv != "" { [ #abv(r.abv)] } else { [ #text(font: sans, size: 7.1pt)[%]] }
}

#let title(t) = text(size: 20pt, weight: "bold", tracking: -0.4pt, t)
#let h-section(t, tag: "") = block(above: 0pt, below: 7pt, sticky: true)[
  #text(size: 14pt, weight: "bold", t)
  #if tag != "" [\ #text(size: 10pt, weight: "bold", style: "italic", tag)]
]
#let h-group(t, tag: "") = block(above: 14pt, below: 7pt, sticky: true)[
  #text(size: 11.3pt, weight: "bold", t)
  #if tag != "" [\ #text(size: 10pt, weight: "bold", style: "italic", tag)]
]
#let h-sub(t, tag: "") = block(above: 9pt, below: 6.5pt, sticky: true)[
  #text(size: 10pt, weight: "bold", t)
  #if tag != "" [\ #text(size: 10pt, weight: "bold", style: "italic", tag)]
]

// ---------- one wine ----------
#let bottle-entry(r, first-in-sub) = block(breakable: false, above: 0pt, below: 9.3pt, {
  [#metadata((sub: r.subgroup, group: r.group, first: first-in-sub)) <ent>]
  hang(r.low_intervention)
  grid(columns: cols-bottle, row-gutter: 0pt,
    {
      [#r.producer]
      if r.size != "" and r.cuvee == "" [ #text(font: sans, size: 7.1pt)[#r.size]]
      linebreak()
      for (i, c) in (r.cuvee, r.cuvee_line2, r.cuvee_line3).enumerate() {
        if c != "" {
          [#c]
          if i == 0 and r.size != "" and r.cuvee_line2 == "" [ #text(font: sans, size: 7.1pt)[#r.size]]
          if i == 0 and r.on_tap == "Y" [, #emph[on tap]]
          linebreak()
        }
      }
      region-line(r)
    },
    emph(r.grapes),
    move(dy: 1.2pt, price(r.price)),
  )
})

#let glass-entry(r) = block(breakable: false, above: 0pt, below: 9.3pt, {
  hang(r.low_intervention)
  grid(columns: cols-glass,
    {
      [#r.producer, #r.cuvee]
      if r.on_tap == "Y" [, #emph[on tap]]
      linebreak()
      region-line(r)
    },
    emph(r.grapes),
    ..(r.price_125, r.price_375, r.price_750).map(p => move(dy: 1.2pt, price(p))),
  )
})
// the sweet wines are poured in 50 ml: price sits in the first price column
#let glass-entry-50(r) = block(breakable: false, above: 0pt, below: 9.3pt, {
  hang(r.low_intervention)
  grid(columns: cols-glass,
    { [#r.producer, #r.cuvee]; linebreak(); region-line(r) },
    emph(r.grapes),
    move(dy: 1.2pt, price(r.price_50)), [], [])
})

// ---------- glass / carafe / bottle icons ----------
#let icon-glass = box(width: 8pt, height: 11pt, {
  place(top + center, polygon(fill: ink, (0pt, 0pt), (6.4pt, 0pt), (5.6pt, 4pt), (4pt, 5.2pt), (2.4pt, 5.2pt), (0.8pt, 4pt)))
  place(top + center, dy: 5pt, rect(width: 0.9pt, height: 4.2pt, fill: ink))
  place(top + center, dy: 9.2pt, rect(width: 4.6pt, height: 0.9pt, fill: ink))
})
#let icon-carafe = box(width: 8pt, height: 14pt, {
  place(top + center, rect(width: 3pt, height: 5pt, fill: ink))
  place(top + center, dy: 4.5pt, polygon(fill: ink, (1pt, 0pt), (6pt, 0pt), (7.6pt, 7pt), (7.6pt, 9.4pt), (0pt, 9.4pt), (0pt, 7pt)))
})
#let icon-bottle = box(width: 8pt, height: 17pt, {
  place(top + center, rect(width: 2.6pt, height: 7pt, fill: ink))
  place(top + center, dy: 6pt, rect(width: 7.2pt, height: 11pt, fill: ink, radius: (top: 2.6pt)))
})
#let size-head(ic, label) = box(width: 18pt, align(center + bottom, stack(dir: ttb, spacing: 2pt, ic, text(font: sans, size: 7.1pt, label))))
#let glass-header = {
  set align(right)
  stack(dir: ltr, spacing: 0pt,
    size-head(icon-glass, "125"), size-head(icon-carafe, "375"), box(width: 26pt, align(center + bottom, stack(dir: ttb, spacing: 2pt, icon-bottle, text(font: sans, size: 7.1pt, "750 ml")))))
}

// ---------- page setup ----------
#set page(
  width: 140mm, height: 255mm,
  margin: (left: 40pt, right: 22pt, top: 27mm, bottom: 12mm),
  header-ascent: 0pt,
  header: context {
    let pg = here().page()
    let marks = query(<partmark>).filter(m => m.location().page() <= pg)
    if marks.len() == 0 { return }
    let p = marks.last().value
    let bottle-part = p == "By the Bottle"
    // "<sub-region> continued" when the first wine on this page continues a block from the previous page
    let cont = none
    if bottle-part {
      let es = query(<ent>).filter(e => e.location().page() == pg)
      if es.len() > 0 {
        let v = es.first().value
        if not v.first {
          cont = if v.sub != "" { v.sub } else if v.group != "" { v.group } else { none }
        }
      }
    }
    block(height: 27mm, width: 100%, {
      place(top + left, dy: 20pt, if calc.even(pg) { title(p) })
      if not bottle-part { place(bottom + right, dx: 2pt, dy: -2pt, glass-header) }
      if cont != none { place(bottom + left, dy: -4pt, text(size: 10pt, weight: "bold")[#cont continued]) }
    })
  },
)
#set text(font: serif, size: 9.2pt, lang: "en", fill: ink, hyphenate: false, features: ("kern", "liga"))
#set par(leading: 5.4pt, spacing: 0pt, justify: false)

// ---------- cover / intro ----------
#page(header: none, margin: (left: 34pt, right: 22pt, top: 26pt, bottom: 12mm))[
  #text(size: 28pt, weight: "bold", tracking: -0.6pt)[Toklas Wine List]
  #v(30pt)
  #set text(size: 10.2pt)
  #set par(leading: 0.5em, spacing: 1.15em)
  #for para in intro.split("\n\n") {
    par(para.trim().split("\n").join(linebreak()))
  }
]

// ---------- by the glass & carafe ----------
#set-part("By the Glass & Carafe")
#{
  let sec = ""
  for r in glass {
    if r.section != sec {
      sec = r.section
      if sec == "Sweet & Oxidative" {
        v(14pt)
        grid(columns: (1fr, 40pt), h-section(sec), align(right + bottom, stack(dir: ttb, spacing: 2pt, icon-glass, text(font: sans, size: 7.1pt)[50ml])))
      } else {
        // each colour keeps to its own block; Rosé starts the next page as in the printed list
        if sec == "Rosé" { pagebreak() } else if sec != "Sparkling" { v(14pt) }
        h-section(sec)
      }
    }
    if r.section == "Sweet & Oxidative" { glass-entry-50(r) } else { glass-entry(r) }
  }
}

// ---------- by the bottle ----------
#{
  let sec = ""; let grp = ""; let sub = ""
  for r in wines {
    let first-in-sub = false
    if r.section != sec {
      sec = r.section; grp = ""; sub = ""
      pagebreak(weak: true)
      set-part("By the Bottle")
      h-section(sec, tag: if sec == "Skin Contact" { "texture, grip, savoury edges" } else { "" })
    }
    if r.group != grp {
      grp = r.group; sub = ""
      if grp != "" { h-group(grp, tag: r.group_tagline) }
    }
    if r.subgroup != sub {
      sub = r.subgroup
      if sub != "" { h-sub(sub, tag: r.subgroup_tagline) }
    }
    // is this the first wine of its (sub)group? used for the "continued" headings
    let prev = wines.at(wines.position(x => x.id == r.id) - 1, default: none)
    first-in-sub = prev == none or prev.section != r.section or prev.group != r.group or prev.subgroup != r.subgroup
    bottle-entry(r, first-in-sub)
  }
}
