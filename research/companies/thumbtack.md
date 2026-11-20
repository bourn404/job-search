# Thumbtack (researched 2026-10-01)

## Mission
- "Thumbtack helps millions of people confidently care for their homes": the one app for urgent repairs,
  maintenance, and improvements, with 300,000 local service businesses. (JD, Senior SWE, Design Systems,
  posted 2026-09-25, [Ashby](https://jobs.ashbyhq.com/thumbtack/f82051f8-b3f1-498d-b273-58e1b56f4925))
- Older mission framing: "To help everyone do life's work with joy and purpose."
  ([Life @ Thumbtack, mission post](https://medium.com/life-thumbtack/our-mission-the-impact-we-want-to-make-on-the-world-0b8c5fd97e6c))

## Stated values & culture
- Values: Lead With Why, Make It Count, Own It, Choose Teamwork, Say What You Mean.
  ([Introducing Thumbtack's values](https://medium.com/life-thumbtack/introducing-thumbtacks-values-f513ea09e927);
  [Comparably](https://www.comparably.com/companies/thumbtack/mission))
- Virtual-first; named Best Remote Large Company 2025 by Built In (search summary; unverified detail).

## Engineering & design values / practices
- **Thumbprint** ([thumbprint.design](https://thumbprint.design)): Thumbtack's design system across React,
  iOS, Android, and SCSS/JS; 50+ components, guidelines (color, type, spacing, accessibility), atomic
  utilities, tokens, icons; invites contributions "big and small from designers and developers".
- **How Thumbtack structures their design system** (Figma blog, Daniel O'Connor, Staff SWE, 2023-07-13):
  three layers (tokens, atomic utilities, components), each trading flexibility for quality and
  productivity; teams can drop to a lower layer instead of building bespoke UI, so the system enables teams
  rather than blocking them; systems should make the right thing easy and the wrong thing annoying but not
  impossible. ([Figma blog](https://www.figma.com/blog/how-thumbtack-structures-their-design-system/))
  Older post; paraphrase the philosophy, don't cite it as news.

## Team context: Design Systems (Senior SWE, remote US)
- Small, senior team: a design manager and two product designers, plus two engineers in Productivity
  Engineering. This role: web + AI-assisted workflows; the partner engineer does cross-platform components
  and tokens. Partners: Developer Experience (agent and tooling foundation), Frontend Infrastructure (web).
- Greenfield: an AI-assisted design-to-code pipeline, a bidirectional bridge between Figma and Thumbprint's
  React components, agentic workflows from low-fi exploration to production, a prototyping platform for
  designers, PMs, and engineers; Claude Code and Figma MCP; machine-readable docs and MCP-friendly component
  metadata; office hours and adoption; evaluate emerging AI dev tooling.
- Pay (Utah = "all other US locations"): $179,400 to $232,100.

## Genuine overlaps with Carson
- **Design system consumable by agents** ↔ his skills that translate designs into code and code into
  designs, AI-generated Figma components from code, Figma Code Connect rollout, conventions enforced for
  engineers and agents, static analysis for DS violations. Nearly one-to-one.
- **Right thing easy, wrong thing annoying** ↔ his "pit of success" conviction, nearly word for word.
- **Adoption that sticks** ↔ DS adoption tracking tooling, coaching product teams, feedback from engineers
  and designers, accessibility training curriculum and workshops.
- **Designers prototyping in code** ↔ setting designers up to prototype with real DS components using AI
  tooling; designers opening PRs for small UI fixes.

## Notes for letters
- Lead with the pit-of-success conviction tying to Thumbprint's philosophy (paraphrased, no quotes).
- Story: making SchoolAI's design system usable by agents and designers (design-to-code and back).
- Don't reuse GM's letter (also people + agents + pit of success): different opener sentence and story angle.
