# Bring Your Own Template

Use your own PowerPoint as the template once; generate on-brand decks with one
command forever after. This is the highest-leverage thing a new user can do —
the bundled Inner Chapter template is only a demo.

## The mental model

A template is not a background. It is a set of **slide-master layouts** (Title,
Content + Image, 3-Column, Grid, Contact, …). This skill places your content
into those layouts' real placeholders. So the quality of your decks is bounded
by the quality and variety of layouts in your `.pptx`. A template with rich,
well-named layouts produces rich decks; a one-layout template produces
monotony.

## Onboarding in this sandbox (no CLI, no subagents)

There is no `profile.py` pipeline here. In Cerea the equivalent of profiling
is reading the template's layout inventory and trying a throwaway outline:

```python
import edit, generate, validate

print(json.dumps(edit.inventory("your-template.pptx"), indent=1)[:2000])
generate.generate("smoke-outline.md", "smoke.pptx", template_path="your-template.pptx")
print(validate.validate("smoke.pptx"))
```

Layout selection falls back to matching body-placeholder counts, so the deck
is sensible even without a config; `**Layout: name**` pins an exact layout
when the inventory shows one you want.
