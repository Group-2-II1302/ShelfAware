<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import { ZONES } from '$lib/shelf';

  let { data }: { data: PageData } = $props();

  let selectedShelf = $state<string | null>(null);
  let selectedSlot = $state<number | null>(null);

  // ✅ safe fallback shelf (replaces $effect + prevents blank UI)
  const activeShelfId = $derived(
    selectedShelf ?? data.shelves?.[0]?.id ?? null
  );

  function selectShelf(id: string) {
    selectedShelf = id;
    selectedSlot = null;
  }

  function selectSlot(slot: number) {
    selectedSlot = slot;
  }

  function getSlot(slotIndex: number) {
    const shelfId = activeShelfId;
    if (!shelfId) return null;

    return data.slotsByShelf?.[shelfId]?.find(
      s => s.scale_index === slotIndex
    ) ?? null;
  }

  function continueToScanner() {
    if (!activeShelfId || selectedSlot === null) return;

    const slot = getSlot(selectedSlot);
    const replace = slot?.status === 'filled' ? '1' : '0';

    goto(
      `/scan/barcode?shelf_id=${encodeURIComponent(activeShelfId)}&slot=${selectedSlot}&replace=${replace}`
    );
  }
</script>

<main class="scan-item">

  <!-- STEP 1 -->
  <section>
    <h1>Select Shelf</h1>

    <div class="grid">
      {#each data.shelves as shelf}
        <button
          class:selected={selectedShelf === shelf.id}
          onclick={() => selectShelf(shelf.id)}
        >
          {shelf.name}
        </button>
      {/each}
    </div>
  </section>

  <!-- STEP 2 -->
  {#if activeShelfId}
    <section>
      <h2>Select Slot</h2>

      {#each ZONES as zone}
        <div class="zone">
          <h3>{zone.label}</h3>

          <div class="slots">
            {#each zone.slotIndices as slotIndex}
              {@const slot = getSlot(slotIndex)}

              <button
                class:selected={selectedSlot === slotIndex}
                onclick={() => selectSlot(slotIndex)}
              >
                <div class="slot-title">Slot {slotIndex}</div>

                {#if slot?.status === 'filled'}
                  <div class="slot-name">
                    {slot.item.product_name ?? slot.item.barcode}
                  </div>
                {:else}
                  <div class="slot-empty">Empty</div>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <!-- STEP 3 -->
  {#if activeShelfId && selectedSlot !== null}
    <button class="continue" onclick={continueToScanner}>
      Continue to Scan
    </button>
  {/if}

</main>