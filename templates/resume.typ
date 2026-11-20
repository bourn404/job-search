// Resume template. Called as #resume(json("/build/data.json")).

#import "/templates/lib.typ": setup, masthead, section, bullets, MUTED, COMPANY

// Invisible layout probes (metadata isn't drawn, so output stays byte-identical):
// - line-probe marks where a skills line or bullet starts and ends (y gives the real line count);
// - line-stats replays Typst's greedy wrapping (non-justified text, no hyphenation; breaks at
//   spaces and after "-" or "/") to find each item's last line and how full it is, so the render
//   step can flag one- or two-word last lines and wrapped skills lines.
#let line-probe(edge, i, j) = context [#metadata((
  edge: edge, i: i, j: j, page: here().page(),
  x: here().position().x / 1pt, y: here().position().y / 1pt,
))<line-probe>]

#let wrap-pieces(s) = {
  let out = ()
  for (wi, w) in s.split(" ").enumerate() {
    let buf = ""
    let first = true
    for c in w.clusters() {
      buf += c
      if (c == "-" or c == "/") and buf.len() > 1 {
        out.push((buf, first and wi > 0))
        buf = ""
        first = false
      }
    }
    if buf != "" { out.push((buf, first and wi > 0)) }
  }
  out
}

#let line-stats(s, i, j, bold-prefix: "") = context {
  // Usable width of a list item's body: page minus side margins, list indent, marker, body indent.
  let avail = page.width - 1in - 2pt - measure([•]).width - 7pt
  let width-of(t, first-line) = if first-line and bold-prefix != "" {
    measure([#text(weight: "bold")[#bold-prefix] #t]).width
  } else { measure(text(t)).width }
  let lines = 1
  let cur = ""
  for (p, space) in wrap-pieces(s) {
    let cand = if cur == "" { p } else if space { cur + " " + p } else { cur + p }
    if cur != "" and width-of(cand, lines == 1) > avail {
      lines += 1
      cur = p
    } else { cur = cand }
  }
  [#metadata((i: i, j: j, lines: lines, last: cur, frac: width-of(cur, lines == 1) / avail))<line-stats>]
}

#let resume(data) = {
  show: setup(paper: "us-letter", margin: (x: 0.5in, top: 0.4in, bottom: 0.38in))
  masthead(data.name, data.headline, data.contact)

  // ── Key Skills ──────────────────────────────────────────────────────────
  section("Key Skills")
  bullets(
    data.skills.enumerate().map(((j, s)) => [#line-probe("start", -1, j)#text(weight: "bold")[#s.label:] #s.items#line-probe("end", -1, j)#line-stats(s.items, -1, j, bold-prefix: s.label + ":")]),
    gap: 5pt,
  )

  // ── Experience ──────────────────────────────────────────────────────────
  section("Experience")

  for (i, e) in data.experiences.enumerate() {
    if i > 0 {
      // Tight gap between consecutive bullet-less one-liners; airier otherwise.
      let prev-oneliner = data.experiences.at(i - 1).bullets.len() == 0
      v(if prev-oneliner and e.bullets.len() == 0 { 4pt } else { 9pt })
    }
    // Single header line: bold title, then company + location (lighter & smaller),
    // with the date range(s) right-aligned. A bullet set follows unless the entry is a
    // compact one-liner (no bullets).
    grid(
      columns: (1fr, auto),
      align: (left + bottom, right + bottom),
      column-gutter: 10pt,
      {
        text(weight: "bold")[#e.title]
        text(fill: COMPANY, size: 9.5pt)[, #e.company#if e.location != "" [, #e.location]]
      },
      text(fill: MUTED, size: 9.5pt)[#e.dateRanges.join("  ·  ")],
    )
    if e.bullets.len() > 0 {
      v(3pt)
      bullets(e.bullets.enumerate().map(((j, b)) => [#line-probe("start", i, j)#b#line-probe("end", i, j)#line-stats(b, i, j)]))
    }
  }

  // ── Education ───────────────────────────────────────────────────────────
  section("Education")
  for (i, ed) in data.education.enumerate() {
    if i > 0 { v(5pt) }
    text(weight: "bold")[#ed.school]
    linebreak()
    text(fill: MUTED)[#ed.degree]
  }

  // Invisible probe: records the page and y-position where content ends, so the render
  // step can report how much vertical space is left (a space-fill feedback signal).
  context [#metadata((page: here().page(), y: here().position().y / 1pt))<fill-probe>]
}
