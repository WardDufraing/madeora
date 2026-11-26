# Independent review: UX settings layout (feat/ui-settings-layout)

Scope: `apps/web/src/app/(app)/settings/page.tsx`, new `components/settings/settings-layout.tsx` (+ test), en/nl messages. Read-only review of `git diff origin/main...origin/feat/ui-settings-layout`; no source edited. CI / tests were not run by the reviewer.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM items are recommended before or soon after merge.

## Findings

### MEDIUM-1: `decodeURIComponent` can throw on a malformed hash and crash the page

`settings-layout.tsx` `hashId()` calls `decodeURIComponent(window.location.hash.slice(1))` inside the effect's `sync()`. `/settings#%` or `#%E0%A4%A` throws `URIError` in the effect, which reaches the nearest error boundary and replaces the whole Settings page. A hash is attacker- or typo-controllable (any shared link).
Remediation: wrap in try/catch and return null (or compare against the raw hash).

### MEDIUM-2: current-section marker goes stale

The "current" state is set only from the hash. (a) With no hash, the first item is marked `aria-current` even while the user scrolls to later groups (no scroll-spy). (b) Deep links that are not a group id, notably the retained `#sign-in-methods` (oauth-callback.tsx L58, L148; returns from Google link/unlink), leave `active` unchanged, so the nav highlights "Account" while the user is looking at Security. The marker is then wrong for sighted users and assistive tech alike.
Remediation: map `sign-in-methods` to `security` (resolve the hash target's closest group `id`), and either add an IntersectionObserver or only set `aria-current` after an explicit hash/selection.

### LOW-1: `aria-current="location"` highlight is shown for the default first item with no user action

Related to MEDIUM-2; a conservative option is to omit `aria-current` until a section is chosen.

### LOW-2: forced-colors border appears only on the current item

`forced-colors:aria-[current=location]:border` adds 1px to the current link only, causing a small layout shift and, since the base has no border, differing box sizes. Also verify `border-[Highlight]` is emitted as a colour (not width) in the built CSS. Remediation: use `border border-transparent` on all links and set `border-[Highlight]` for current under forced-colors.

### LOW-3: select jump does not move focus and sticky offset is a magic number

`window.location.hash = id` scrolls but the focus stays on the select (acceptable for a jump menu; the group container is not focusable). `top-24` / `scroll-mt-24` are not tied to a header height; there is no sticky app header so this is merely generous. `#sign-in-methods` keeps its own `scroll-mt-20` inside the security group (fine).

### LOW-4: test gaps

Unit test does not cover: hash not in sections, malformed hash, `hashchange` after mount, `#sign-in-methods`. No e2e for the nav on desktop/phone or forced-colors.

## Checks

- Cards and conditions (old vs new): all 15 Cards present once. Moved only: Accent and Appearance (theme) now together in "Appearance"; Activity moved from Security block to "Your data"; Notifications, Ora, Google Calendar, Dashboard templates in "Connections"; Recovered-homes card now inside Security. Conditions intact: `user ?` around the sign-in-methods card with its `id="sign-in-methods"` wrapper (anchor kept), `hasRecovered ?`, `isStaff ?` (staff card still last, after the groups, outside any group so it is not in the section list; acceptable), and the `unavailable` FormAlert. All `data-testid`s preserved. Order change is not harmful; the staff card losing a nav entry is minor.
- Group `id`s (`profile`, `appearance`, `language`, `security`, `data`, `connections`): no duplicate ids found in apps/web/src. The "Language and region" nav label doubles as a group label and card title (group label is `aria-hidden`).
- E2E (tests/e2e/specs): flows using `/settings` (members, storage, google-calendar, shell theme/locale, ownership-recovery staff-link, account-switching) use roles/testids that are unchanged. `getByRole("button",{name:"Save"}).first()` still resolves to the display-name Save (Profile card remains first). Radios `Dark`, `Nederlands`, `English`, `Same as this device` are not affected by the select's options (role option) or nav links. Heading queries (`level: 1`) unaffected: group labels are `<p aria-hidden>`, not headings. `mainNav` is scoped to the sidebar; other specs filter navigation by `/main/i` or other names, and "Settings sections" matches none. Phone overflow check (shell.spec L565): select is `w-full`, grid only at `lg`. No strict-mode ambiguity found. Axe landmark-unique: the new nav has a unique name.
- Accessibility: `<nav aria-label>` landmark; select has a visible `<label htmlFor>`; both nav variants are toggled by `display:none` so only one is in the accessibility tree; `min-h-11` select and `min-h-10` links; hover/current styles use tokens; focus ring comes from global `:focus-visible`. RTL: grid and padding use logical behaviour (start-side column via grid order); no physical left/right classes. Forced colors: see LOW-2.
- Hydration/SSR: `useState(first)` is identical on server and client; `window` is read only inside `useEffect`/event handler. No mismatch. Hash-derived state appears after mount (brief flash of first item as current).
- i18n: new keys `sectionsLabel`, `jumpTo`, `groupProfile`, `groupAppearance`, `groupSecurity`, `groupData`, `groupConnections` present in both en and nl with matching placement; `languageAndRegion` reused for the language entry.

## Remaining risks / test gaps

- See LOW-4. Visual verification at lg with long nl labels (13rem column) not performed; labels are short and wrap.
