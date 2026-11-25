<template>
  <div class="claim-gate">
    <div v-if="state.loading" class="loading">Checking claims…</div>
    <div v-else-if="state.error" class="error">
      Error: {{ state.error.message }}
      <button @click="refetch" class="retry-btn">Retry</button>
    </div>
    <div v-else>
      <ul class="claims-list">
        <li
          v-for="(ok, type) in state.claims"
          :key="type"
          :class="['claim-item', ok ? 'verified' : 'unverified']"
        >
          <span class="claim-type">{{ type }}</span>
          <span class="claim-status">{{ ok ? '✅' : '❌' }}</span>
        </li>
      </ul>
      <button @click="refetch" class="refresh-btn">Refresh</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { createClaimGate, type ClaimGate } from '@stellarcred/sdk';

interface Props {
  wallet: string;
  claims?: string[];
}

const props = withDefaults(defineProps<Props>(), {
  claims: () => [],
});

const state = ref({
  claims: null as Record<string, boolean> | null,
  loading: true,
  error: null as Error | null,
});

let gate: ClaimGate | null = null;

function refetch() {
  gate?.refetch();
}

onMounted(() => {
  gate = createClaimGate({
    wallet: props.wallet,
    claims: props.claims.length > 0
      ? (props.claims as any)
      : undefined,
  });
  gate.subscribe((s) => {
    state.value = {
      claims: s.claims as Record<string, boolean> | null,
      loading: s.loading,
      error: s.error,
    };
  });
});

onUnmounted(() => {
  gate?.destroy();
});
</script>

<style scoped>
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
