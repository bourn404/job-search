// Cover letter template. Called as #coverLetter(json("/build/data.json")).
// Shares the masthead with the resume; body paragraphs come from the selection spec.

#import "/templates/lib.typ": setup, masthead

#let coverLetter(data) = {
  show: setup(paper: "us-letter")
  masthead(data.name, data.headline, data.contact)

  let cl = data.coverLetter

  // Body sits in a narrower centered column, vertically centered in the space below the
  // masthead (biased slightly above middle, like the source letter).
  v(1fr)
  align(center)[
    #block(width: 78%)[
      #set par(leading: 0.72em, spacing: 1.35em, justify: false)
      #set align(left)
      #cl.greeting
      #parbreak()
      #for p in cl.body {
        p
        parbreak()
      }
      #cl.signoff
      #parbreak()
      #data.name
    ]
  ]
  v(1.7fr)
}
