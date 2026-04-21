<script>
  import Menu from '$lib/components/Menu.svelte'
  import Navbar from '$lib/components/Navbar.svelte'
</script>

<Navbar />
<h1>welcome to shelfAware</h1>
<p>your shelves</p>

<ul class="shelf-list">
  <li class="shelf-list__item">
    <a href="/fridge" class="shelf-list__link">
      fridge
    </a>
  </li>

  <li class="shelf-list__item">
    <a href="/pantry" class="shelf-list__link">
      pantry
    </a>
  </li>
</ul>
<Menu />
