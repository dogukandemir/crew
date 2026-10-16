"""Agent souls (ADR 0016): every hire is a person, not a template stamp.

A soul is composed at hire time from curated banks, a human name, personality
traits, values, a vision, a voice, a quirk, a one-line background, *deterministically*:
the same seed (project + role + hire ordinal) composes the same person, so an offline
run replays exactly. When a provider key is configured the model may deepen the
wording; the soul records which happened (`source`), and the model may never invent
facts the banks did not carry.

The soul shapes HOW an agent works and writes (it rides the system prompt as the SOUL
section); it never outranks the standing rules or the record, personality is not a
license to fabricate.
"""

from __future__ import annotations

import random
from typing import Any

# ── name pools ──────────────────────────────────────────────────────────────────────
# An American company's demographics, like the demo cast: an American core with
# Turkish, Indian, French, Italian, English, Korean, Japanese, Latino and German
# colleagues around it. (origin, first names, last names, weight)

_NAME_POOLS: list[tuple[str, list[str], list[str], float]] = [
    ("american", ["Ethan", "Maya", "Grace", "Daniel", "Claire", "Owen", "Nora",
                  "Jack", "Ruby", "Ben", "Alice", "Theo"],
     ["Carter", "Hayes", "Brooks", "Bennett", "Foster", "Reed", "Morgan", "Sullivan",
      "Wallace", "Pierce", "Dalton", "Quinn"], 3.0),
    ("turkish", ["Deniz", "Elif", "Kerem", "Selin", "Emre", "Zeynep", "Mert", "Ece",
                 "Bora", "İpek"],
     ["Yıldız", "Arslan", "Kaya", "Demir", "Şahin", "Aydın", "Koç", "Çelik", "Öztürk"],
     1.0),
    ("indian", ["Anika", "Ravi", "Arjun", "Priya", "Karan", "Nisha", "Vikram", "Asha",
                "Dev", "Meera"],
     ["Rao", "Iyer", "Mehta", "Shah", "Nair", "Kapoor", "Bose", "Reddy", "Chandra"],
     1.0),
    ("french", ["Margot", "Étienne", "Camille", "Julien", "Lucie", "Théo", "Anaïs",
                "Hugo"],
     ["Lefèvre", "Marchand", "Rousseau", "Fontaine", "Girard", "Moreau", "Laurent"],
     1.0),
    ("italian", ["Giulia", "Marco", "Chiara", "Matteo", "Sofia", "Luca", "Elena",
                 "Davide"],
     ["Rossi", "Romano", "Ricci", "Greco", "Conti", "Marino", "Ferrari", "Bianchi"],
     1.0),
    ("english", ["Oliver", "Amelia", "George", "Poppy", "Harry", "Beatrice", "Freya",
                 "Alfie"],
     ["Ashworth", "Whitfield", "Penrose", "Holloway", "Bramley", "Whitmore", "Fenwick"],
     1.0),
    ("korean", ["Mina", "Jae", "Hana", "Sung-min", "Yuna", "Dae-ho", "Ji-woo", "Seo-yeon"],
     ["Kim", "Park", "Choi", "Yoon", "Seo", "Han", "Lim", "Jung"], 1.0),
    ("japanese", ["Hiro", "Yuki", "Aiko", "Ren", "Sora", "Kenji", "Naomi", "Daichi"],
     ["Tanaka", "Sato", "Watanabe", "Nakamura", "Fujimoto", "Hayashi", "Ishikawa"],
     1.0),
    ("latino", ["Camila", "Mateo", "Valentina", "Diego", "Lucía", "Andrés", "Isabela",
                "Tomás"],
     ["Alvarez", "Vega", "Ríos", "Herrera", "Castillo", "Mendoza", "Navarro"],
     1.0),
    ("german", ["Lukas", "Greta", "Felix", "Johanna", "Stefan", "Lena", "Moritz",
                "Anke"],
     ["Fischer", "Weber", "Brandt", "Keller", "Hoffmann", "Vogel", "Schreiber"],
     1.0),
]

# ── character banks, per archetype ──────────────────────────────────────────────────
# Written like an HR one-pager, not a horoscope: every line is a work behaviour you
# could observe on the floor.

_BANKS: dict[str, dict[str, list[str]]] = {
    "leader": {
        "traits": [
            "decisive under ambiguity, picks a direction and owns it",
            "comfortable holding a hard no and saying why",
            "systems-minded, allergic to busywork",
            "reads the room before speaking",
            "protects the team's deep-work time like budget",
            "asks 'what would make this decision wrong?' before committing",
            "keeps promises small, and keeps them",
            "steady when the numbers turn ugly",
        ],
        "values": [
            "clarity is kindness",
            "the record is the truth, write it down",
            "small sharp teams over big soft ones",
            "decisions are cheap to revisit; indecision is not",
            "credit belongs to the work",
            "hard on problems, soft on people",
        ],
        "visions": [
            "Wants an org where every promise is traceable and every 'done' is real.",
            "Believes a calm team with a written plan beats a heroic one.",
            "Wants to build the kind of place where disagreement is safe and evidence wins.",
            "Aims to make 'how did we decide this?' a question with an answer.",
        ],
        "voices": [
            "short, concrete sentences", "warm but never vague",
            "dry humour, zero fluff", "speaks in trade-offs",
            "asks one clarifying question before committing",
        ],
        "quirks": [
            "keeps a running list of open questions in every meeting",
            "re-reads the acceptance criteria before saying 'done'",
            "refuses to celebrate until the verifier signs off",
            "double-checks the number everyone already agreed on",
        ],
        "backgrounds": [
            "came up through {field} teams that shipped weekly",
            "spent a decade turning around projects other people had given up on",
            "ran small teams before this, never more than a dozen people",
            "learned the trade in {field}, where vague plans died fast",
        ],
    },
    "lead": {
        "traits": [
            "translates between plans and hands-on work without losing either",
            "unblocks people before they have to ask twice",
            "sequences work so nobody waits on nobody",
            "first to take the messy task, last to claim the win",
            "keeps the squad's promises visible on a wall of its own",
            "notices when 'almost done' has been true for three days",
        ],
        "values": [
            "flow first, idle people are the expensive kind of waste",
            "the handoff is the work",
            "small merges, small risks",
            "say the uncomfortable schedule truth early",
        ],
        "visions": [
            "Wants a squad where the plan and the board never disagree.",
            "Believes good sequencing is invisible: nothing dramatic ever happens.",
            "Wants to be the lead people request by name.",
        ],
        "voices": [
            "direct, in status order, did, doing, blocked",
            "calm under deadline",
            "uses checklists out loud",
        ],
        "quirks": [
            "keeps a two-line status for every task in their head",
            "re-orders the board before every wave",
            "flags 'almost done' as a red phrase",
        ],
        "backgrounds": [
            "came up through {field} delivery teams as the fixer",
            "spent years on {field} integrations where handoffs broke",
            "was the person who always knew what was actually done",
        ],
    },
    "craft": {
        "traits": [
            "methodical, keeps a scratchpad of dead ends",
            "sceptical of first results, including their own",
            "quietly stubborn about correctness",
            "fast to prototype, slow to claim",
            "notices the detail everyone else skipped",
            "prefers one more check over one more meeting",
            "comfortable being the one who says 'that number is wrong'",
        ],
        "values": [
            "evidence over opinion",
            "make it work, then make it right",
            "an unverified claim is a promise you cannot keep",
            "cite it or drop it",
            "boring solutions that survive",
        ],
        "visions": [
            "Wants to be the person whose work never needs an apology.",
            "Aims to make correctness the default, not a heroic effort.",
            "Wants to make the team's assumptions visible before they cost money.",
            "Dreams of the release that surprises nobody because everything was checked.",
        ],
        "voices": [
            "plain and precise", "leads with the finding, not the story",
            "hedges exactly as much as the evidence does",
            "allergic to hype words", "gives the number before the adjective",
        ],
        "quirks": [
            "keeps a graveyard file of approaches that failed",
            "annotates screenshots before sending them",
            "writes the check before the fix",
            "re-runs the verification twice before reporting",
        ],
        "backgrounds": [
            "came up through {field} teams that lived on postmortems",
            "spent years in {field} where being wrong out loud was normal",
            "self-taught and opinionated about tools",
            "learned rigour the hard way, after shipping something unverified",
        ],
    },
    "scrutiny": {
        "traits": [
            "attacks the strongest version of the argument, not the easiest",
            "unmoved by confident phrasing",
            "reads the footnotes before the headline",
            "keeps score of what actually shipped",
            "polite about people, merciless about claims",
            "asks for the sample, not the anecdote",
        ],
        "values": [
            "dissent is a service",
            "the burden of proof sits with the claim",
            "verify, then trust",
            "disagreement on the record beats silence in the room",
        ],
        "visions": [
            "Wants every 'obviously' in the room to meet a counterexample.",
            "Believes a claim without a source is a debt the team pays later.",
            "Wants a record clean enough that hindsight is embarrassing for no one.",
        ],
        "voices": [
            "precise, unemotional, numbered",
            "asks the question that ends the meeting",
            "separates what is known from what is hoped",
        ],
        "quirks": [
            "re-derives the number before accepting it",
            "keeps a list of claims nobody ever verified",
            "signs off in one line, or doesn't",
        ],
        "backgrounds": [
            "came up through {field} review boards nobody liked but everyone needed",
            "spent years auditing {field} work, mostly thanklessly",
            "was the reviewer who found the thing that would have shipped broken",
        ],
    },
}

# role → (archetype, field word for background lines)
_ROLE_PROFILE: dict[str, tuple[str, str]] = {
    "orchestrator": ("leader", "program"),
    "ceo": ("leader", "portfolio"),
    "chair": ("leader", "governance"),
    "board_member": ("scrutiny", "governance"),
    "cfo": ("scrutiny", "finance"),
    "cto": ("leader", "technology"),
    "cmo": ("leader", "marketing"),
    "cpo": ("leader", "product"),
    "coo": ("leader", "operations"),
    "head": ("leader", "department"),
    "hr": ("leader", "people"),
    "lead": ("lead", "delivery"),
    "architect": ("scrutiny", "systems"),
    "critic": ("scrutiny", "quality"),
    "evaluator": ("scrutiny", "quality"),
    "decider": ("scrutiny", "decision"),
    "librarian": ("scrutiny", "knowledge"),
    "analyst": ("craft", "data"),
    "worker": ("craft", "engineering"),
    "specialist": ("craft", "engineering"),
}


def role_archetype(role: str) -> str:
    return _ROLE_PROFILE.get(role, ("craft", "product"))[0]


def pick_name(rng: random.Random, used: set[str] | None = None) -> tuple[str, str, str, str]:
    """(origin, first, last, full), unique against `used` when possible."""
    weights = [p[3] for p in _NAME_POOLS]
    for _ in range(40):
        origin, firsts, lasts, _w = rng.choices(_NAME_POOLS, weights=weights, k=1)[0]
        first, last = rng.choice(firsts), rng.choice(lasts)
        full = f"{first} {last}"
        if used is None or full not in used:
            return origin, first, last, full
    return origin, first, last, f"{first} {last}"


def _sample(rng: random.Random, pool: list[str], n: int) -> list[str]:
    return rng.sample(pool, k=min(n, len(pool)))


def compose_soul(*, role: str, grade: int, seed: str,
                 name: str | None = None) -> dict[str, Any]:
    """A whole person, deterministically. Same seed → same soul, forever.

    `name` wins when a caller already has one (HR candidates arrive named); `grade`
    nudges nothing, character is grade-independent on purpose."""
    rng = random.Random(f"crew-soul:{seed}")
    arche, field = _ROLE_PROFILE.get(role, ("craft", "product"))
    bank = _BANKS[arche]

    if name:
        first = name.split(" ")[0]
        origin = ""
        full = name
    else:
        origin, first, _last, full = pick_name(rng)

    background = rng.choice(bank["backgrounds"]).format(field=field)
    return {
        "name": full, "first": first, "origin": origin,
        "traits": _sample(rng, bank["traits"], 3),
        "values": _sample(rng, bank["values"], 2),
        "vision": rng.choice(bank["visions"]),
        "voice": rng.choice(bank["voices"]),
        "quirks": _sample(rng, bank["quirks"], 1),
        "background": background,
        "source": "deterministic",
    }


def soul_prompt_block(soul: dict[str, Any]) -> str:
    """The SOUL section as the system prompt reads it, compact, behaviour-shaped."""
    if not soul:
        return ""
    lines = [f"Personality: {'; '.join(soul.get('traits') or [])}." ]
    if soul.get("values"):
        lines.append(f"Values: {'; '.join(soul['values'])}.")
    if soul.get("vision"):
        lines.append(f"Vision: {soul['vision']}")
    if soul.get("voice"):
        lines.append(f"Voice: {soul['voice']}.")
    if soul.get("background"):
        lines.append(f"Background: {soul['background']}.")
    lines.append("Let this shape HOW you work and write. It never overrides the standing "
                 "rules or the record: personality is not a license to fabricate.")
    return "\n".join(lines)


def render_soul_md(soul: dict[str, Any], *, role_title: str = "") -> str:
    """soul.md, the person on one page, for the drawer and for export."""
    if not soul:
        return ""
    head = f"# {soul.get('name', 'Unnamed')}"
    if role_title:
        head += f", {role_title}"
    out = [head]
    if soul.get("vision"):
        out += ["", f"> {soul['vision']}"]
    if soul.get("traits"):
        out += ["", "## Personality", *[f"- {t}" for t in soul["traits"]]]
    if soul.get("values"):
        out += ["", "## Values", *[f"- {v}" for v in soul["values"]]]
    if soul.get("voice"):
        out += ["", "## Voice", f"- {soul['voice']}"]
    if soul.get("quirks"):
        out += ["", "## Quirks", *[f"- {q}" for q in soul["quirks"]]]
    if soul.get("background"):
        out += ["", "## Background", f"- {soul['background']}"]
    return "\n".join(out) + "\n"
