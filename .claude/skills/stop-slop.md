# stop-slop — PrimeCore Intelligence Writing Standard

Remove AI writing patterns from every surface a client reads. Apply when writing or reviewing: onboarding agent messages, marketing copy, email templates, Alex Vega sequences, error messages, button labels, legal notices, FAQ answers.

---

## Core Rules

**1. Cut filler phrases.**
Remove these on sight:
- "Here's the thing:" / "Let that sink in." / "The uncomfortable truth is."
- "Navigate" when you mean "handle" or "deal with"
- "Unpack" before any analysis
- "This matters because" — if it matters, the sentence that follows shows it
- "At the end of the day" / "Moving forward" / "At its core"
- "Seamlessly" / "Robust" / "Cutting-edge" / "Leverage" / "Empower"
- "Not because X. Because Y." — formulaic contrast
- "And that's okay." — false reassurance

**2. Name the actor.**
Inanimate things don't do things. People do.

| Slop | Human |
|------|-------|
| "The AI resolves the call" | "Your caller gets an answer" |
| "Shadow mode activates" | "We start listening" |
| "The onboarding begins" | "You'll get an email within 2 minutes" |
| "Decisions emerge from data" | "You decide — we give you the numbers" |
| "Results depend on configuration" | "How you set it up changes what you get" |

**3. Break metronomic rhythm.**
If three consecutive sentences are the same length, break one.
Short. Short. Short. Dead. Vary it — one long sentence that carries the reader somewhere, then a short one that lands.

**4. Don't answer your own questions.**
Asking "What does shadow mode mean?" and immediately answering it is a tell.
Either ask a real question you don't answer, or just say the thing directly.

**5. Trust the reader.**
- Explaining a metaphor kills it
- No hand-holding ("As you can see above")
- No softening ("You might want to consider")
- No justification after a statement ("This is important because...")

**6. Cut the punchy closer.**
Ending every section with a one-liner summary is a pattern.
"And that's the power of PrimeCore." Delete it.

**7. No tripling.**
AI defaults to exactly three examples. When you have two good ones, use two.
"We support Five9, Genesys, and 3CX" is fine when those are the most common.
"We support Five9, Genesys, 3CX, RingCentral, Bliss, and Atento" is a list — use a list.

---

## PrimeCore-Specific Banned Phrases

These appear in existing copy and need replacing:

| Found in | Phrase | Replace with |
|----------|--------|--------------|
| Marketing hero | "AI-augmented" | specific benefit: "handles 89% of calls" |
| Onboarding | "Shadow mode means..." | just show what happens during shadow mode |
| Alex Vega | "The math is impossible to ignore" | give the number and stop |
| Pilot form | "No surprises" | state the guarantee specifically |
| Pilot email | "We will contact you" | "You'll hear from us by [time]" |
| Legal | "The Services" every 4 words | use "PrimeCore" once established |

---

## Scoring (run before any client-facing copy ships)

Rate 1–10 on each:

| Dimension | Question |
|-----------|----------|
| Directness | Does it make statements or just announce things? |
| Rhythm | Is the sentence length varied or metronomic? |
| Trust | Does it treat the reader as smart? |
| Authenticity | Would a real person at PrimeCore say this? |
| Density | Is anything cuttable without losing meaning? |

Below 35/50 → revise before shipping.

---

## Applied to PrimeCore Surfaces

**Agent messages (onboarding, Alex Vega):**
Write as if Lester sent the message personally. Not "PrimeCore Intelligence welcomes you."
Say: "We're ready on our end — here's what you do next."

**Marketing copy:**
One claim per sentence. The claim is the number or the outcome.
Not: "PrimeCore Intelligence's advanced AI technology enables seamless autonomous resolution of customer inquiries at scale."
Say: "89% of your calls get handled without an agent."

**Error messages:**
Say what happened and what the person does next.
Not: "An error occurred. Please try again."
Say: "That didn't go through. Try again or email support@primecoreintelligence.com."

**Legal copy:**
Legal must be precise — don't oversimplify. But remove throat-clearing.
Not: "In the event that you experience difficulties..."
Say: "If something breaks..."

---

## License
MIT — original by Hardik Pandya (https://hvpandya.com/stop-slop). This version adapted for PrimeCore Intelligence.
