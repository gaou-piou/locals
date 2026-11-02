<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { Switch } from "$lib/components/ui/switch";
  import { setGlobal } from "$lib/api";
  import type { SettingsStore } from "$lib/settings-store.svelte";

  let { store }: { store: SettingsStore } = $props();
  const s = $derived(store.current);
</script>

{#if s}
  <div class="flex flex-col gap-4">
    <Card.Root>
      <Card.Header>
        <Card.Title>Serve libraries locally</Card.Title>
        <Card.Description>Replaces requests to known CDNs with the copies bundled in the extension.</Card.Description>
        <Card.Action>
          <Switch checked={s.enabled} aria-label="Serve libraries locally" onCheckedChange={(v) => setGlobal({ enabled: v })} />
        </Card.Action>
      </Card.Header>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Substitute close versions</Card.Title>
        <Card.Description>
          When a page asks for a version that is not bundled, serve the newest bundled release of the same major version. The extension
          cannot see page hashes: a page that pins its script with an SRI hash will be blocked by the browser when a different version
          is served. Because this can break sites, it is off by default.
        </Card.Description>
        <Card.Action>
          <Switch
            checked={s.substitute}
            disabled={!s.enabled}
            aria-label="Substitute close versions"
            onCheckedChange={(v) => setGlobal({ substitute: v })}
          />
        </Card.Action>
      </Card.Header>
    </Card.Root>
  </div>
{/if}
