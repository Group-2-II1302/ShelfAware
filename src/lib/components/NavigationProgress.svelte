<!--
  Top progress bar that appears whenever a SvelteKit navigation is in
  flight. Wired off `navigating` from `$app/state`, which is a thin
  reactive value (object while a nav is pending, null otherwise).

  Rationale: every other route transition in the app was previously
  silent until the server load resolved, which on slow connections
  reads as "nothing's happening." A single shared bar at the top of
  the viewport is the cheapest universal signal we can wire in.

  A short delay (120ms) before showing the bar prevents flicker on
  cached / instant navigations (very common with SvelteKit's pre-
  fetching). If the nav resolves inside that window the user never
  sees the bar; if it takes longer, the bar appears and animates a
  pseudo-progress curve (we can't read real progress from the load
  function, so the curve approaches but never reaches 100% until the
  navigation actually completes).
-->
<script lang="ts">
  import { navigating } from '$app/state'

  const SHOW_DELAY_MS = 120
  /*
    Progress curve: hops from 0 → ~30% on start, then geometrically
    crawls toward 90% so a slow load still looks like it's making
    progress without ever lying about completing.
  */
  const TICK_INTERVAL_MS = 200
  const CEILING = 0.9

  let visible = $state(false)
  let progress = $state(0)
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined

  function start() {
    progress = 0.3
    visible = true
    tickTimer = setInterval(() => {
      // Asymptotic approach toward CEILING. Slows as it gets closer.
      progress = progress + (CEILING - progress) * 0.15
    }, TICK_INTERVAL_MS)
  }

  function finish() {
    progress = 1
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = undefined
    /*
      Hold the filled bar briefly so the user sees it complete, then
      fade it out. Without this, fast navs feel like the bar was
      never really there.
    */
    setTimeout(() => {
      visible = false
      progress = 0
    }, 250)
  }

  $effect(() => {
    if (navigating.to) {
      // Debounce — most navs are fast enough that we shouldn't flash.
      if (showTimer) clearTimeout(showTimer)
      showTimer = setTimeout(start, SHOW_DELAY_MS)
    } else {
      if (showTimer) {
        clearTimeout(showTimer)
        showTimer = undefined
      }
      if (visible) {
        finish()
      } else if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = undefined
      }
    }
  })
</script>

{#if visible}
  <div class="nav-progress" role="status" aria-live="polite" aria-label="Loading">
    <div
      class="nav-progress__bar"
      style:width="{progress * 100}%"
    ></div>
  </div>
{/if}

<style>
  .nav-progress {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    z-index: 1000;
    pointer-events: none;
    background: transparent;
  }

  .nav-progress__bar {
    height: 100%;
    background: linear-gradient(
      90deg,
      var(--matcha, #84a98c),
      var(--matcha-deep, #5e7d68)
    );
    /*
      Soft glow on the leading edge so it reads as motion even when
      the asymptote slows the width animation to a crawl.
    */
    box-shadow: 0 0 8px rgba(94, 125, 104, 0.55);
    transition: width 0.2s ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .nav-progress__bar {
      transition: none;
    }
  }
</style>
