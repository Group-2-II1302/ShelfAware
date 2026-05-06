<script>
  import {
    IconHome2Filled,
    IconCameraFilled,
    IconBellFilled,
    IconDots,
  } from '@tabler/icons-svelte'
</script>

<div id="menu">
  <ul>
    <li><a href="/"><IconHome2Filled size={32} /></a></li>
    <li><a href="/scan/barcode"><IconCameraFilled size={32} /></a></li>
    <li><a href="/inbox"><IconBellFilled size={32} /></a></li>
    <li><IconDots size={32} /></li>
  </ul>
</div>
