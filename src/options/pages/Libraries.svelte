<script lang="ts">
  import { Debounced, resource } from "runed";
  import { Badge } from "$lib/components/ui/badge";
  import { Input } from "$lib/components/ui/input";
  import * as Table from "$lib/components/ui/table";
  import { getLibraries } from "$lib/api";
  import { filterLibraries } from "$lib/config";

  const libraries = resource(
    () => true,
    () => getLibraries(),
  );

  let query = $state("");
  const debounced = new Debounced(() => query, 250);
  const shown = $derived(filterLibraries(libraries.current ?? [], debounced.current));
</script>

<div class="flex flex-col gap-4">
  <Input type="search" bind:value={query} placeholder="Filter libraries…" aria-label="Filter libraries" />

  {#if libraries.error}
    <p class="text-destructive text-sm" role="alert">{libraries.error.message}</p>
  {:else}
    <p class="text-muted-foreground text-xs">{shown.length} of {libraries.current?.length ?? 0} libraries</p>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Library</Table.Head>
          <Table.Head>Bundled versions</Table.Head>
          <Table.Head>License</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each shown as lib (lib.name)}
          <Table.Row>
            <Table.Cell class="font-medium">{lib.name}</Table.Cell>
            <Table.Cell>
              <div class="flex flex-wrap gap-1">
                {#each lib.versions as v (v.version)}
                  <Badge variant="secondary">{v.version}</Badge>
                {/each}
              </div>
            </Table.Cell>
            <Table.Cell>{lib.license}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</div>
