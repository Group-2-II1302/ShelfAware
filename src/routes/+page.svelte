<script lang="ts">
  import Navbar from '$lib/components/Navbar.svelte'
  import Menu from '$lib/components/Menu.svelte'
  import { onMount } from 'svelte'
  import { browser } from '$app/environment'

  import {
    IconApple,
    IconBread,
    IconCalendarTime,
    IconChevronLeft,
    IconCookie,
    IconFish,
    IconMilk,
    IconX,
  } from '@tabler/icons-svelte'

  type ShelfLocation = 'fridge' | 'pantry'
  type ShelfViewMode = 'shelf' | 'item'

  type ShelfItem = {
    id: string
    name: string
    description: string
    expiryDate: string
    nutrition: string
    weight: string
    icon: any
  }

  type Shelf = {
    id: string
    name: string
    location: ShelfLocation
    items: ShelfItem[]
  }

  const STORAGE_KEY = 'shelfaware:shelves'

  const starterShelves: Shelf[] = [
    {
      id: 'fridge-demo',
      name: 'Daily fridge shelf',
      location: 'fridge',
      items: [
        {
          id: 'milk',
          name: 'Milk',
          description: 'Whole milk for coffee, cereal, and cooking.',
          expiryDate: '2026-04-25',
          nutrition: '64 kcal per 100 ml',
          weight: '1.0 L',
          icon: IconMilk,
        },
        {
          id: 'yogurt',
          name: 'Greek Yogurt',
          description: 'Protein-rich snack and breakfast base.',
          expiryDate: '2026-04-29',
          nutrition: '97 kcal per 100 g',
          weight: '500 g',
          icon: IconCookie,
        },
      ],
    },
    {
      id: 'pantry-demo',
      name: 'Pantry shelf',
      location: 'pantry',
      items: [
        {
          id: 'bread',
          name: 'Bread',
          description: 'Sandwich bread stored in the pantry.',
          expiryDate: '2026-05-02',
          nutrition: '265 kcal per 100 g',
          weight: '700 g',
          icon: IconBread,
        },
        {
          id: 'apples',
          name: 'Apples',
          description: 'Fresh fruit snack.',
          expiryDate: '2026-05-10',
          nutrition: '52 kcal per 100 g',
          weight: '1.2 kg',
          icon: IconApple,
        },
        {
          id: 'tuna',
          name: 'Tuna Can',
          description: 'Protein source for quick meals.',
          expiryDate: '2027-01-15',
          nutrition: '116 kcal per 100 g',
          weight: '185 g',
          icon: IconFish,
        },
      ],
    },
  ]

  let shelves = $state<Shelf[]>([])
  let storageReady = $state(false)

  let createShelfOpen = $state(false)
  let shelfName = $state('')
  let shelfLocation = $state<ShelfLocation>('fridge')

  let activeShelf = $state<Shelf | null>(null)
  let activeItem = $state<ShelfItem | null>(null)
  let activeView = $state<ShelfViewMode>('shelf')

  onMount(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      shelves = stored ? JSON.parse(stored) : starterShelves
    } catch {
      shelves = starterShelves
    }

    storageReady = true
  })

  $effect(() => {
    if (!browser || !storageReady) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shelves))
  })

  function openCreateShelf() {
    createShelfOpen = true
  }

  function closeCreateShelf() {
    createShelfOpen = false
    shelfName = ''
    shelfLocation = 'fridge'
  }

  function createShelf(event: SubmitEvent) {
    event.preventDefault()

    shelves = [
      ...shelves,
      {
        id: crypto.randomUUID(),
        name: shelfName.trim() || 'Blank shelf',
        location: shelfLocation,
        items: [],
      },
    ]

    closeCreateShelf()
  }

  function openShelf(shelf: Shelf) {
    activeShelf = shelf
    activeItem = null
    activeView = 'shelf'
  }

  function openItem(item: ShelfItem) {
    activeItem = item
    activeView = 'item'
  }

  function backToShelf() {
    activeItem = null
    activeView = 'shelf'
  }

  function closeShelfModal() {
    activeShelf = null
    activeItem = null
    activeView = 'shelf'
  }

  function shelvesFor(location: ShelfLocation) {
    return shelves.filter((s) => s.location === location)
  }
</script>

<Navbar />

<main class="inventory-page">
  <section class="inventory-block">
    <h1>Fridge</h1>

    <div class="shelf-grid">
      {#each shelvesFor('fridge') as shelf (shelf.id)}
        <button
          type="button"
          class="shelf-card"
          aria-label={`Open shelf ${shelf.name}`}
          onclick={() => openShelf(shelf)}
        >
          <h2>{shelf.name}</h2>
          <p>{shelf.items.length} items</p>
        </button>
      {/each}
    </div>
  </section>

  <section class="inventory-block">
    <h1>Pantry</h1>

    <div class="shelf-grid">
      {#each shelvesFor('pantry') as shelf (shelf.id)}
        <button
          type="button"
          class="shelf-card"
          aria-label={`Open shelf ${shelf.name}`}
          onclick={() => openShelf(shelf)}
        >
          <h2>{shelf.name}</h2>
          <p>{shelf.items.length} items</p>
        </button>
      {/each}
    </div>
  </section>
</main>

<Menu onAddShelf={openCreateShelf} />

{#if createShelfOpen}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="create-shelf-title">
    <button class="modal__backdrop" type="button" aria-label="Close create shelf dialog" onclick={closeCreateShelf}></button>

    <div class="modal__panel">
      <h2 id="create-shelf-title">Create shelf</h2>

      <form class="stack-form" onsubmit={createShelf}>
        <label class="field">
          <span>Shelf name</span>
          <input class="input" bind:value={shelfName} placeholder="Shelf name" />
        </label>

        <div class="choice-row" role="group" aria-label="Shelf location">
          <button
            type="button"
            class:selected={shelfLocation === 'fridge'}
            aria-label="Select fridge"
            onclick={() => (shelfLocation = 'fridge')}
          >
            Fridge
          </button>

          <button
            type="button"
            class:selected={shelfLocation === 'pantry'}
            aria-label="Select pantry"
            onclick={() => (shelfLocation = 'pantry')}
          >
            Pantry
          </button>
        </div>

        <button type="submit" class="btn-primary">Create</button>
      </form>
    </div>
  </div>
{/if}

{#if activeShelf}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shelf-title">
    <button class="modal__backdrop" type="button" aria-label="Close shelf dialog" onclick={closeShelfModal}></button>

    <div class="modal__panel">
      <div class="modal__panel-header">
        <button type="button" class="icon-button" aria-label="Close shelf view" onclick={closeShelfModal}>
          <IconX />
        </button>

        <h2 id="shelf-title">{activeShelf.name}</h2>
      </div>

      {#if activeView === 'shelf'}
        <div class="item-grid">
          {#each activeShelf.items as item (item.id)}
            <button
              type="button"
              class="item-card"
              aria-label={`Open item ${item.name}`}
              onclick={() => openItem(item)}
            >
              <div class="item-card__icon">
                <item.icon />
              </div>

              <div>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
              </div>
            </button>
          {/each}
        </div>
      {/if}

      {#if activeView === 'item' && activeItem}
        <div class="item-detail">
          <button type="button" class="icon-button" aria-label="Back to shelf items" onclick={backToShelf}>
            <IconChevronLeft />
          </button>

          <h3>{activeItem.name}</h3>
          <p>{activeItem.description}</p>

          <p>Expiry: {activeItem.expiryDate}</p>
          <p>Nutrition: {activeItem.nutrition}</p>
          <p>Weight: {activeItem.weight}</p>
        </div>
      {/if}
    </div>
  </div>
{/if}