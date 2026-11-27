<script lang="ts">
  import { createClaimGate, type ClaimGate } from '@stellarcred/sdk';
  import { onMount, onDestroy } from 'svelte';
  import { writable } from 'svelte/store';

  export let wallet: string;
  export let claims: string[] = [];

  const state = writable({
    claims: null as Record<string, boolean> | null,
    loading: true,
    error: null as Error | null,
  });

  let gate: ClaimGate | null = null;

  function refetch() {
    gate?.refetch();
  }

  onMount(() => {
    gate = createClaimGate({
      wallet,
      claims: claims.length > 0 ? (claims as any) : undefined,
    });
    gate.subscribe((s) => {
      state.set({
        claims: s.claims as Record<string, boolean> | null,
        loading: s.loading,
        error: s.error,
      });
    });
  });

  onDestroy(() => {
    gate?.destroy();
  });
</script>

<div class="claim-gate">
  {#if $state.loading}
    <div class="loading">Checking claims…</div>
  {:else if $state.error}
    <div class="error">
      Error: {$state.error.message}
      <button on:click={refetch} class="retry-btn">Retry</button>
    </div>
  {:else}
    <ul class="claims-list">
      {#each Object.entries($state.claims || {}) as [type, ok]}
        <li class="claim-item" class:verified={ok} class:unverified={!ok}>
          <span class="claim-type">{type}</span>
          <span class="claim-status">{ok ? '✅' : '❌'}</span>
        </li>
      {/each}
    </ul>
    <button on:click={refetch} class="refresh-btn">Refresh</button>
  {/if}
</div>

<style>
  .claim-gate {
    font-family: system-ui, sans-serif;
    padding: 1rem;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    max-width: 320px;
  }
  .loading { color: #666; }
  .error { color: #c00; }
  .retry-btn {
    margin-left: 0.5rem;
    padding: 2px 8px;
    cursor: pointer;
  }
  .claims-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.5rem 0;
  }
  .claim-item {
    display: flex;
    justify-content: space-between;
    padding: 0.25rem 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .claim-type { font-weight: 500; }
  .claim-status { margin-left: 0.5rem; }
  .verified { color: #0a0; }
  .unverified { color: #c00; }
  .refresh-btn {
    cursor: pointer;
    padding: 4px 12px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #f8f8f8;
  }
</style>
