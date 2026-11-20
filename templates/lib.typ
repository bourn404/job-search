// Shared setup + header used by both the resume and the cover letter.

#let FONT = "Arial"
#let MUTED = rgb("#3d3d3d")
#let COMPANY = rgb("#5f5f5f") // company/location header: lighter than the bold job titles
#let RULE = 1pt + rgb("#8a8a8a")
#let INK = rgb("#1a1a1a")

// Page + text defaults. Used as a parameterized wrapping show rule: `#show: setup()`
// passes the rest of the document in as `body`, so these set rules govern the whole
// document. Both résumé and cover letter are US Letter (8.5x11"). Default leading 0.58em
// matches the source's ~1.15 line-height for 11pt Arial. `date: none` keeps PDF metadata
// timestamp-free for byte-reproducible output.
#let setup(
  paper: "us-letter",
  margin: (x: 0.8in, top: 0.6in, bottom: 0.6in),
  size: 11pt,
  leading: 0.58em,
) = (body) => {
  set document(date: none)
  set page(paper: paper, margin: margin)
  set text(font: FONT, size: size, fill: INK)
  set par(leading: leading, spacing: 0.65em, justify: false)
  body
}

// Shared masthead: name + headline on the left, contact block right-aligned, then a rule.
#let masthead(name, headline, contact) = {
  grid(
    columns: (1fr, auto),
    column-gutter: 12pt,
    align: (left + horizon, right + horizon),
    {
      text(size: 19pt, weight: "bold")[#name]
      linebreak()
      v(2pt)
      text(size: 11pt, fill: MUTED)[#headline]
    },
    {
      set text(size: 11pt, fill: MUTED)
      set par(leading: 0.5em)
      align(right)[
        #contact.email
        #linebreak()
        #contact.phone
        #for l in contact.links {
          linebreak()
          l
        }
      ]
    },
  )
  v(5pt)
  line(length: 100%, stroke: RULE)
  v(3pt)
}

// Section heading with an underline rule, e.g. "Experience". Generous space above so
// section breaks read as a clearly stronger separator than the gaps between experiences.
#let section(title) = {
  v(11pt)
  text(weight: "bold", size: 11.5pt)[#title]
  v(0.5pt)
  line(length: 100%, stroke: RULE)
  v(4pt)
}

// Bulleted list with a filled-circle marker. `leading` keeps wrapped lines WITHIN a bullet
// tight; `gap` gives each bullet a little breathing room from the next.
#let bullets(items, gap: 7pt) = {
  set par(leading: 0.46em, spacing: 0.5em)
  list(
    marker: text(fill: INK)[•],
    indent: 2pt,
    body-indent: 7pt,
    spacing: gap,
    ..items,
  )
}
