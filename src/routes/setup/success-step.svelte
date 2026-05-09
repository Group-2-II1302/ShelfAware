<script lang="ts">
    let { onFinish } = $props<{ onFinish: () => void }>();

    function finish() {
        onFinish();
    }
</script>

<h2>Device Connected Successfully</h2>
<button onclick={finish}>Go to Shelf</button>