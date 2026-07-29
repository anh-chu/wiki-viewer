# Known issue: slash-opacity utilities emit no CSS

**Status: FILED, DELIBERATELY NOT FIXED.** Ruled by the reviewing session
(019f936d) on 2026-07-29, during the viewer extraction. Reproduction:
`node scripts/check-slash-opacity.mjs` (requires a built app).

## Symptom

Every Tailwind opacity modifier applied to one of this app's **design tokens**
produces no rule at all. `bg-muted/50`, `text-foreground/70`, `bg-primary/10`
and friends are silently no-ops: the element renders with no background, no
tint, no dimming. Nothing errors, nothing warns, and the class name is right
there in the markup.

## Measurement

Against the built CSS, with `.flex` and `.bg-muted` checked first so a negative
result could be trusted:

```
slash-opacity utilities used in src/: 83
  emit a rule:      14
  emit NOTHING:     69
```

The split is not arbitrary. **All 14 that work use Tailwind's built-in
palette**, where the colour is a hex value the compiler can composite:

```
.bg-amber-500\/10{background-color:#f59e0b1a}
```

**All 69 that fail reference a design token** — `foreground`,
`muted-foreground`, `primary`, `destructive`, `card`, `secondary`, `accent`,
`border`, `warning-ink` — declared in `tailwind.config.ts` as a plain string:

```ts
muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" }
```

Tailwind v3 cannot apply an alpha modifier to a plain string colour, so it emits
nothing rather than failing loudly.

## The fix is known and already proven

`packages/viewer` had the identical defect and it is fixed there. Colour tokens
became FUNCTIONS, which receive the modifier:

```ts
const wv = (name: string) => ({ opacityValue }: { opacityValue?: string } = {}) => {
  const alpha = Number(opacityValue);
  return opacityValue !== undefined && Number.isFinite(alpha) && alpha < 1
    ? `color-mix(in oklab, var(--wv-${name}) ${alpha * 100}%, transparent)`
    : `var(--wv-${name})`;
};
```

Result, in the package's shipped CSS:

```
.bg-muted\/50{background-color:color-mix(in oklab,var(--wv-muted) 50%,transparent)}
```

Without a modifier the output is byte-identical to the old plain `var()`, so the
change is additive.

## Why this is filed rather than fixed

Reasons given by the reviewing session, recorded because they are the useful part:

1. **Out of scope.** The objective was extracting a viewer; that shipped in
   `d46acdd`.
2. **It is a whole-app visual change, not a bug fix in effect.** Applying it
   turns ~69 opacity treatments on simultaneously across every surface, none of
   them reviewed, several behind text. That deserves its own before-and-after
   pass.
3. **The review loop is expensive.** A full app build is roughly ten minutes, so
   iterating on visual fallout needs a deliberate budget.
4. **Nothing is broken in a way anyone has noticed.** The app has been shipping
   in this state.

## One part is already fixed

The shared document page (`/s/[token]`) renders through `@wiki-viewer/viewer`,
whose tokens are already functions, so the CSV header background, source-view row
hover and outline highlight are correct there today. The code path an external
consumer uses is not affected by this issue.

## A warning for whoever picks this up

Do not measure it with a naive substring grep. The first run of the script above
reported `bg-muted/50` as working, because the app's CSS contains:

```
[data-skin=editorial] .bg-muted\/50.border-b{background-color:var(--background)!important}
```

which is a hand-written skin override *referencing* the class, not Tailwind
generating the utility. The script now requires the class to terminate its
compound selector, optionally behind a variant prefix. Two sessions lost hours to
this class of error on 2026-07-29: an instrument that inspects a representation of
the system, and is perfectly accurate about the representation while being wrong
about the question.
