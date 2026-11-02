<script lang="ts">
  import { resource } from "runed";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Table from "$lib/components/ui/table";
  import { clearObserved, getObserved, getPending, refreshLearned } from "$lib/api";

  let version = $state(0);
  const ready = resource(
    () => version,
    () => getObserved(),
  );
  const waiting = resource(
    () => version,
    () => getPending(),
  );
  const readyRows = $derived(ready.current ?? []);
  const waitingRows = $derived(waiting.current ?? []);

  function download() {
    const body = JSON.stringify({ schema: 1, candidates: readyRows }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "cdn-mirror-candidates.json" }).click();
    URL.revokeObjectURL(url);
  }

  let applied = $state<number>();
  async function apply() {
    applied = await refreshLearned();
  }

  async function clear() {
    await clearObserved();
    version++;
  }
</script>

<div class="flex flex-col gap-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>Discovered</Card.Title>
      <Card.Description>
        Versioned third-party scripts, styles and fonts. A URL is first <em>waiting</em>; once a second, different site loads it, it becomes
        <em>ready</em>. Only the URL and counts are kept, never which sites you visited. The extension downloads nothing: export the ready list, run
        <code>cdn-mirror-learn</code> on it, then press Apply learned.
      </Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onclick={download} disabled={!readyRows.length}>Export ready ({readyRows.length})</Button>
      <Button variant="outline" onclick={apply}>Apply learned</Button>
      <Button variant="outline" onclick={() => version++}>Refresh</Button>
      <Button variant="ghost" onclick={clear} disabled={!readyRows.length && !waitingRows.length}>Clear all</Button>
      {#if applied !== undefined}<span class="text-muted-foreground text-sm">{applied} learned libraries active</span>{/if}
    </Card.Content>
  </Card.Root>

  {#if ready.error || waiting.error}
    <p class="text-destructive text-sm" role="alert">{(ready.error ?? waiting.error)?.message}</p>
  {:else}
    <section class="flex flex-col gap-2">
      <h2 class="flex items-center gap-2 text-sm font-medium">Ready to learn <Badge variant="secondary">{readyRows.length}</Badge></h2>
      {#if readyRows.length}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>URL</Table.Head>
              <Table.Head class="text-right">Sites</Table.Head>
              <Table.Head class="text-right">Hits</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each readyRows as c (c.url)}
              <Table.Row>
                <Table.Cell class="break-all">{c.url}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{c.sites}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{c.hits}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {:else}
        <p class="text-muted-foreground text-sm">Nothing has been seen on two different sites yet.</p>
      {/if}
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="flex items-center gap-2 text-sm font-medium">Waiting for a second site <Badge variant="secondary">{waitingRows.length}</Badge></h2>
      {#if waitingRows.length}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>URL</Table.Head>
              <Table.Head class="text-right">Seen on</Table.Head>
              <Table.Head class="text-right">Hits</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each waitingRows as c (c.url)}
              <Table.Row>
                <Table.Cell class="break-all">{c.url}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{c.sites} of 2 sites</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{c.hits}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {:else}
        <p class="text-muted-foreground text-sm">Nothing waiting. Versioned third-party files will show up here after the first site that loads them.</p>
      {/if}
    </section>
  {/if}
</div>
