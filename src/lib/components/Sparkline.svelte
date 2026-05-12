<script lang="ts">
  /*
    Tiny inline-SVG sparkline. No charting library — at this size and
    fidelity, a hand-rolled polyline is both lighter and gives us full
    control over the visual language (matcha line, faint area fill,
    optional last-point dot).

    Input is just an array of numbers. We don't render axes, ticks,
    or tooltips by design; the caller provides label/min/max context
    elsewhere on the card.
  */
  let {
    values,
    width = 120,
    height = 32,
    strokeWidth = 1.5,
    color = 'var(--matcha)',
    fill = 'var(--matcha-soft)',
    showDot = true,
  }: {
    values: number[]
    width?: number
    height?: number
    strokeWidth?: number
    color?: string
    fill?: string
    showDot?: boolean
  } = $props()

  const path = $derived.by(() => {
    if (values.length < 2) return { line: '', area: '', lastX: 0, lastY: 0 }

    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1

    /*
      Pad y by half a stroke so the line never gets clipped at the
      top or bottom edge. Pad x by half a stroke for the same reason
      at the start/end.
    */
    const padY = strokeWidth
    const padX = strokeWidth
    const innerW = width - padX * 2
    const innerH = height - padY * 2

    const points = values.map((v, i) => {
      const x = padX + (i / (values.length - 1)) * innerW
      const y = padY + (1 - (v - min) / range) * innerH
      return [x, y] as const
    })

    const line = points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' ')

    /*
      Area path closes back to the baseline so the fill reads as
      "stuff below the line" rather than a band around it.
    */
    const area =
      line +
      ` L${points[points.length - 1][0].toFixed(2)},${height - padY} ` +
      `L${points[0][0].toFixed(2)},${height - padY} Z`

    const [lastX, lastY] = points[points.length - 1]
    return { line, area, lastX, lastY }
  })
</script>

<svg
  viewBox="0 0 {width} {height}"
  {width}
  {height}
  aria-hidden="true"
  class="sparkline"
>
  {#if values.length >= 2}
    <path d={path.area} fill={fill} stroke="none" />
    <path
      d={path.line}
      fill="none"
      stroke={color}
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    {#if showDot}
      <circle
        cx={path.lastX}
        cy={path.lastY}
        r={strokeWidth * 1.2}
        fill={color}
      />
    {/if}
  {/if}
</svg>

<style>
  .sparkline {
    display: block;
  }
</style>
