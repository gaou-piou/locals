<script lang="ts">
  import { resource } from "runed";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Table from "$lib/components/ui/table";
  import { clearObserved, getObserved } from "$lib/api";

  const observed = resource(
    () => true,
    () => getObserved(),
  );
  const rows = $derived(observed.current ?? []);

  function download() {
    const body = JSON.stringify({ schema: 1, candidates: rows }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "cdn-mirror-candidates.json" }).click();
    URL.revokeObjectURL(url);
  }

  async function clear() {
    await clearObserved();
    await observed.refetch();
  }
</script>

<div class="flex flex-col gap-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Discovered</Card.Title>
      <Card.Description>
        Versioned third-party scripts, styles and fonts seen on at least two different sites. Only the URL and a count are kept, never which sites
        you visited. Nothing is downloaded or sent anywhere.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex gap-2">
      <Button variant="secondary" onclick={download} disabled={!rows.length}>Export JSON</Button>
      <Button variant="outline" onclick={clear} disabled={!rows.length}>Clear</Button>
    </Card.Content>
  </Card.Root>

  {#if observed.error}
    <p class="text-destructive text-sm" role="alert">{observed.error.message}</p>
  {:else if rows.length}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>URL</Table.Head>
          <Table.Head class="text-right">Sites</Table.Head>
          <Table.Head class="text-right">Hits</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as c (c.url)}
          <Table.Row>
            <Table.Cell class="break-all">{c.url}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{c.sites}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{c.hits}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {:else if !observed.loading}
    <p class="text-muted-foreground text-sm">Nothing yet. Browse a few sites and come back.</p>
  {/if}
</div>
