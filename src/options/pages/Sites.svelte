<script lang="ts">
  import { watch } from "runed";
  import { without } from "ramda";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { setGlobal } from "$lib/api";
  import type { SettingsStore } from "$lib/settings-store.svelte";
  import { normalizeHost } from "../../background/settings.ts";

  let { store }: { store: SettingsStore } = $props();
  const s = $derived(store.current);

  type Key = "disabledSites" | "allowedSites";
  const LISTS: { key: Key; title: string; description: string }[] = [
    { key: "disabledSites", title: "Never on these sites", description: "Requests made by these sites (and by frames embedded in them) are left alone." },
    {
      key: "allowedSites",
      title: "Only on these sites",
      description: "When this list is not empty, redirection happens only on the listed sites.",
    },
  ];

  let drafts = $state<Record<Key, string>>({ disabledSites: "", allowedSites: "" });
  let errors = $state<Record<Key, string>>({ disabledSites: "", allowedSites: "" });

  // a stale error message should not outlive the text that caused it
  watch(
    () => ({ ...drafts }),
    () => {
      errors = { disabledSites: "", allowedSites: "" };
    },
    { lazy: true },
  );

  async function add(key: Key) {
    const host = normalizeHost(drafts[key]);
    if (!host) {
      errors[key] = "Enter a hostname such as example.com";
      return;
    }
    if (!s || s[key].includes(host)) {
      drafts[key] = "";
      return;
    }
    await setGlobal({ [key]: [...s[key], host] });
    drafts[key] = "";
  }
</script>

{#if s}
  <div class="flex flex-col gap-4">
    {#each LISTS as list (list.key)}
      <Card.Root>
        <Card.Header>
          <Card.Title>{list.title}</Card.Title>
          <Card.Description>{list.description}</Card.Description>
        </Card.Header>
        <Card.Content class="flex flex-col gap-3">
          <form
            class="flex gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              void add(list.key);
            }}
          >
            <Input bind:value={drafts[list.key]} placeholder="example.com" aria-label={`Add to “${list.title}”`} aria-invalid={!!errors[list.key]} />
            <Button type="submit" variant="secondary">Add</Button>
          </form>
          {#if errors[list.key]}<p class="text-destructive text-xs" role="alert">{errors[list.key]}</p>{/if}

          {#if s[list.key].length}
            <ul class="flex flex-col divide-y rounded-md border">
              {#each s[list.key] as host (host)}
                <li class="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span>{host}</span>
                  <Button variant="ghost" size="sm" aria-label={`Remove ${host}`} onclick={() => setGlobal({ [list.key]: without([host], s[list.key]) })}>
                    Remove
                  </Button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-muted-foreground text-xs">No sites.</p>
          {/if}
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
{/if}
