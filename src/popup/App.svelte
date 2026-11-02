<script lang="ts">
  import { resource } from "runed";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { getState, openOptions, toggleSite } from "$lib/api";
  import { siteEnabled } from "$lib/config";

  let version = $state(0);
  const view = resource(
    () => version,
    () => getState(),
  );

  const host = $derived(view.current?.tab.host ?? "");
  const enabled = $derived(view.current ? view.current.settings.enabled && siteEnabled(view.current.settings, host) : true);

  async function onToggle(next: boolean) {
    await toggleSite(host, next);
    version++;
  }
</script>

<main class="flex flex-col gap-3 p-4">
  <header class="flex items-center justify-between">
    <h1 class="text-sm font-semibold">Locals</h1>
    {#if view.current && !view.current.settings.enabled}
      <Badge variant="secondary">Paused</Badge>
    {/if}
  </header>

  {#if view.error}
    <p class="text-destructive text-sm" role="alert">Could not reach the extension: {view.error.message}</p>
  {:else if view.current}
    <section class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{host || "No website"}</p>
        <p class="text-muted-foreground text-xs">
          {#if host}{view.current.tab.count} {view.current.tab.count === 1 ? "request" : "requests"} served locally{:else}Open an http(s) page to use this{/if}
        </p>
      </div>
      <Switch checked={enabled} disabled={!host} aria-label={host ? `Enable on ${host}` : "Enable on this site"} onCheckedChange={onToggle} />
    </section>
  {/if}

  <Button variant="outline" size="sm" onclick={() => openOptions()}>Options</Button>
</main>
