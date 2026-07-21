# iOS Safari ITP storage eviction vs. a home-screen-installed PWA's bootstrap cookie

> Feeds research ticket [#36](https://github.com/gianko/groceries/issues/36) (child of map issue #35,
> Pantry Bot's pivot to a standalone web app installed as an iPhone home-screen PWA): whether
> Intelligent Tracking Prevention (ITP) or other iOS Safari storage-eviction behavior threatens the
> team's chosen auth mechanism — a one-time shared-link token that sets a cookie once and never
> re-prompts.
>
> Researched 2026-07-21 against primary sources: the WebKit blog's ITP series
> ([webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/),
> [webkit.org/blog/9521](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/),
> [webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)),
> WebKit's tracking-prevention policy summary
> ([webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/)), WebKit's 2023 storage
> policy update ([webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/)),
> and MDN's Storage API docs
> ([developer.mozilla.org/.../StorageManager/persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)).
> Every claim below is cited to one of these; no claim is sourced from Stack Overflow or unverified
> secondary summaries alone.

## Verdict

**Installation genuinely changes the eviction math, and the design is very likely safe as planned —
with one refinement worth making.** WebKit's own blog states explicitly that home-screen web apps
"are not part of Safari and thus have their own counter of days of use" that resets on the app's own
usage, not Safari's, and that WebKit does "not expect" such an app's data to ever be deleted (§1).
Separately, and independently of installation, **if the bootstrap cookie is set via a `Set-Cookie`
HTTP response header (not `document.cookie` in JavaScript), it was never subject to the 7-day cap in
the first place** — that cap has only ever applied to script-set cookies (§1, §3). Combining
"install as a home-screen app" with "issue the cookie server-side" removes both the general ITP
7-day non-interaction clock and the JS-cookie-specific cap. The realistic residual risk (§2) is not
ITP classifying the app as a tracker — it's the everyday possibility that "not opened for a week" is
optimistic for a genuinely idle 2-person household, plus WebKit's own hedge language ("we do not
*expect*... if it does, let us know") stopping short of a hard guarantee. The recommended mitigation
(§3) is cheap and removes essentially all remaining doubt: re-issue the cookie (reset its expiry) on
every successful page load, so the "eviction clock," to the extent one exists at all for an installed
app, never has a chance to run out between visits that do happen.

---

## 1. Does installation change the 7-day ITP eviction behavior?

**Yes — WebKit explicitly and by name exempts home-screen web apps, in the same blog post that
introduced the current form of the 7-day rule.**

- The 7-day rule itself: ITP 2.1 introduced capping "all persistent client-side cookies, i.e.
  persistent cookies created through `document.cookie`... to a seven day expiry"
  ([webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/)).
  Critically, that post also states "only cookies created through `document.cookie` are affected by
  this change" — cookies set via a server's `Set-Cookie` header are out of scope for this cap from
  the start, and the same post notes such cookies are typically `HttpOnly`, which `document.cookie`
  cannot even set (same source).
- In April 2020, WebKit widened the *non-cookie* storage cap to match: "ITP has aligned the
  remaining script-writable storage forms with the existing client-side cookie restriction, deleting
  all of a website's script-writable storage after seven days of Safari use without user interaction
  on the site" — covering "Indexed DB, LocalStorage, Media keys, SessionStorage, Service Worker
  registrations and cache"
  ([webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/),
  corroborated by [webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/), which
  states the same list verbatim: "ITP deletes all cookies created in JavaScript and all other
  script-writeable storage after 7 days of no user interaction with the website").
- **The home-screen exemption, quoted in full from the same 2020 post** (this is the load-bearing
  sentence for this whole investigation):

  > "As mentioned, the seven-day cap on script-writable storage is gated on 'after seven days of
  > Safari use without user interaction on the site.' That is the case in Safari. Web applications
  > added to the home screen are not part of Safari and thus have their own counter of days of use.
  > Their days of use will match actual use of the web application which resets the timer. We do not
  > expect the first-party in such a web application to have its website data deleted."
  >
  > — [webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)

  The post follows this immediately with an invitation to report violations as bugs: "If your web
  application does experience website data deletion, please let us know since we would consider it
  a serious bug" (same source). That phrasing is the one caveat worth flagging honestly: it is a
  strong statement of intent and a bug-bar commitment, not a formal, numbered guarantee with an SLA —
  but it is about as strong a "this shouldn't happen" as WebKit makes anywhere in this documentation
  set.
- **This is specifically about the general non-interaction eviction clock, not the separate 30-day
  cross-site-tracking-classification purge.** WebKit's tracking-prevention page separately documents
  that "all website data is deleted for classified domains which have not received user interaction
  as first-party... in the last 30 days of browser use"
  ([webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/)). That rule targets
  domains ITP has *classified* as having cross-site tracking capability based on behavioral
  heuristics; it is not relevant here because Pantry Bot's PWA is a same-origin, first-party-only
  app with no cross-site presence to classify — this is a different code path from the 7-day rule
  this ticket asked about, and nothing in the reviewed sources suggests home-screen apps are
  additionally exempted from *this* 30-day rule (it likely wouldn't apply to Pantry Bot at all, given
  it has no third-party/cross-site footprint to trigger classification in the first place).
- **2023 update reinforces rather than reverses the exemption.** WebKit's later storage-policy post
  confirms a home-screen web app runs with "the same origin quota and overall quota as when it is
  opened in a browser app" (i.e., installing doesn't shrink your storage budget), and separately
  states WebKit's persistent-storage grant heuristic explicitly favors home-screen apps: "WebKit
  currently grants a request [to `navigator.storage.persist()`] based on heuristics like whether the
  website is opened as a Home Screen Web App"
  ([webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/)). This doesn't
  restate the 7-day-cap exemption verbatim, but it's consistent with WebKit treating "installed as a
  home-screen app" as a first-class, favorably-treated storage state years after the original 2020
  post.

**Answer to sub-question 1:** No, an installed home-screen PWA does not get the same 7-day
non-interaction purge as a regular Safari tab. WebKit's own blog states home-screen apps run their
own usage clock, independent of Safari's, and states outright that it does not expect their storage
to be deleted at all.

## 2. What's the actual risk window and failure mode for irregular usage?

- **If the cookie is set via `Set-Cookie` (server-side), the 7-day JS-cookie cap never applied to it
  in the first place** — this is true in plain Safari, before even considering installation
  ([webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/)). The
  broader "all script-writable storage" cap from the 2020 post is about storage *created by scripts*
  (JS) — a server-set cookie was never "script-writable" in the sense that phrase is used across
  these posts. So the highest-risk failure mode in the issue's framing (silent logout from a
  same-origin first-party cookie) already has a near-complete mitigation available purely from how
  the cookie is issued, independent of PWA install status.
- **For the home-screen-app case specifically**, WebKit's own language is a statement of expectation
  ("we do not expect... to have its website data deleted"), not an unconditional promise — so the
  honest risk window isn't "zero," it's "very small, and treated by WebKit as a bug if it happens"
  ([webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).
  The exemption is gated on the app being opened in its own standalone/fullscreen display mode via
  its home-screen icon — not merely bookmarked or opened as a regular Safari tab, which *does* still
  face the 7-day clock while the household hasn't visited it via that specific launch surface.
- **Failure mode, if eviction did somehow occur**: silent logout. The cookie (or, per §3, any
  `localStorage`/IndexedDB fallback token) disappears with no error surfaced to the app; the next
  request simply arrives unauthenticated. The user-facing symptom is the app behaving as if never
  bootstrapped, requiring the household to be re-sent (or to re-open) the one-time shared bootstrap
  link. For a 2-person household this is low-severity (an annoyance requiring a re-share of a link
  someone already has saved) rather than a data-loss event — no source reviewed suggests eviction of
  an auth cookie also destroys any server-side pantry data, only the client's copy of its bootstrap
  credential.
- **Realistic trigger for "irregular usage, not opened for a week+"**: per §1, the home-screen app's
  clock only advances on *its own* non-use, and only the general 7-day cap (not the 30-day
  classified-domain purge, which doesn't apply here per §1) is in play. A household that opens the
  app at least once every 7 days keeps resetting that clock indefinitely regardless of how sporadic
  the individual visits are. The genuine edge case is a household member going on a 2+ week trip (or
  simply not using the pantry app for that long) with nobody else opening it either — that's the
  scenario worth defending against explicitly, and where §3's mitigation earns its keep.

**Answer to sub-question 2:** For an installed home-screen app using a server-set cookie, the
practical risk window is close to zero under WebKit's stated policy, with the residual risk being (a)
WebKit's exemption being a strong-but-not-absolute expectation rather than a hard contract, and (b) a
household not opening the app via its home-screen icon for a long enough stretch (in practice, likely
weeks not days, given the app's own idle clock resets on any use) to matter. The failure mode is a
silent, low-stakes logout — not data loss — recoverable by re-sending or re-opening the bootstrap
link.

## 3. Mitigations

Ranked by effectiveness/practicality for this repo's design:

1. **Issue the bootstrap cookie via a `Set-Cookie` HTTP response header, not `document.cookie`.**
   This is close to free (it's how most server frameworks set auth cookies by default) and sidesteps
   the entire "client-side cookie" 7-day cap category described across every ITP post reviewed —
   the cap has only ever targeted script-set storage
   ([webkit.org/blog/8613](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/),
   [webkit.org/blog/10218](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).
   Set it `Secure` and `HttpOnly` for the added benefit of not being readable/overwritable by any
   injected script, and give it a long explicit `Max-Age`/`Expires` (HTTP-header cookies aren't
   capped at 7 days by ITP, though ordinary cookie-jar limits and any `Max-Age` you set yourself
   still apply).
2. **Re-issue (refresh) the cookie's expiry on every authenticated request/page load**, server-side.
   Even though §1-2 suggest the eviction risk is already low for an installed app with a
   header-set cookie, resetting `Set-Cookie`'s `Max-Age` on every visit means the effective
   expiration horizon is always "N days from the last time anyone opened the app" — directly
   addressing the issue's "irregular usage" framing by making the household's own usage pattern the
   only thing that matters, with no dependency on WebKit's exemption behaving exactly as documented.
   This is standard "sliding session" practice and needs no new API.
3. **Ensure the app is actually launched via its home-screen icon in standalone/fullscreen display
   mode**, not just bookmarked or opened from a regular Safari tab, since the exemption in §1 is
   specifically for "web applications added to the home screen," gated on that launch mode (`display:
   standalone` or `fullscreen` in the web app manifest) rather than merely having visited the URL
   before. Verify the manifest's `display` field is set accordingly; this is likely already covered
   by the PWA-install work in issue #35 but is worth confirming explicitly rather than assuming.
4. **Belt-and-suspenders: also store the token in `localStorage` (or IndexedDB) alongside the
   cookie**, and check it as a fallback if the cookie is ever missing. `localStorage` is one of the
   storage forms explicitly named as subject to the 7-day *script-writable* cap
   ([webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/)), so on its own it is
   *not* a stronger mitigation than a header-set cookie — but as a redundant second copy, it means a
   hypothetical eviction event would have to hit both storage forms simultaneously to actually break
   the session, and it gives the app a way to detect "my cookie disappeared" and prompt a graceful
   re-bootstrap rather than a confusing silent failure.
5. **Not recommended as primary defense: `navigator.storage.persist()`.** MDN describes it as
   requesting a durable storage mode so data "will not be cleared except by explicit user action"
   ([developer.mozilla.org/.../StorageManager/persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)),
   and WebKit's 2023 storage-policy post confirms its grant heuristic explicitly favors home-screen
   web apps ("WebKit currently grants a request based on heuristics like whether the website is
   opened as a Home Screen Web App,"
   [webkit.org/blog/14403](https://webkit.org/blog/14403/updates-to-storage-policy/)). It's a
   reasonable belt-and-suspenders call to make once (cheap, a few lines of JS) given it stacks in the
   app's favor precisely because it's installed — but neither WebKit post reviewed states that
   `persist()` overrides or is required to get the ITP 7-day-cap home-screen exemption from §1; that
   exemption is described as automatic based on launch mode, not conditional on calling this API. Add
   it opportunistically, not as the mechanism the design depends on.
6. **Not applicable: Storage Access API.** WebKit's introductory post describes this as a mechanism
   for third-party iframe content to request access to its unpartitioned first-party storage
   ([webkit.org/blog/8124](https://webkit.org/blog/8124/introducing-storage-access-api/)) — it
   addresses cross-origin embedding scenarios, not a same-origin first-party PWA's own cookie. Not
   relevant to Pantry Bot's architecture.

## Sources

- [webkit.org/blog/8613 — Intelligent Tracking Prevention 2.1](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/)
  (introduces the 7-day cap, scoped explicitly to `document.cookie`-created cookies, not
  `Set-Cookie`/`HttpOnly`)
- [webkit.org/blog/9521 — Intelligent Tracking Prevention 2.3](https://webkit.org/blog/9521/intelligent-tracking-prevention-2-3/)
  (related ITP-era policy; no home-screen-app-specific content found)
- [webkit.org/blog/10218 — Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
  (extends the cap to all script-writable storage; contains the load-bearing home-screen-web-app
  exemption quote)
- [webkit.org/tracking-prevention — Tracking Prevention in WebKit](https://webkit.org/tracking-prevention/)
  (policy summary page; corroborates the 7-day script-writable-storage cap and the separate 30-day
  classified-domain purge)
- [webkit.org/blog/14403 — Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
  (2023; confirms home-screen apps share the browser's origin/overall quota and that WebKit's
  `persist()` grant heuristic favors home-screen web apps)
- [webkit.org/blog/8124 — Introducing Storage Access API](https://webkit.org/blog/8124/introducing-storage-access-api/)
  (confirms this API targets third-party iframe storage access, not first-party same-origin cookies —
  used here to rule it out as inapplicable)
- [developer.mozilla.org — StorageManager: persist() method](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
  (secondary/reference source for the Storage API's general behavior and browser-support framing,
  used only to describe the mitigation mechanically, not to source any WebKit-specific behavioral
  claim)
